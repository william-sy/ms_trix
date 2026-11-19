//! Emoji (SAS) verification with other people and our own sessions. Requests
//! we send and requests we receive are both followed to the end and reported
//! as `AdapterEvent::Verification`, so the UI only has to show the state.

use std::sync::Arc;

use futures::StreamExt;
use matrix_sdk::encryption::verification::{QrVerification, QrVerificationState, SasState, SasVerification, Verification as Flow, VerificationRequest, VerificationRequestState};
use matrix_sdk::ruma::events::key::verification::accept::KeyVerificationAcceptEventContent;
use matrix_sdk::ruma::events::key::verification::key::KeyVerificationKeyEventContent;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::key::verification::VerificationMethod;
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use matrix_sdk::ruma::events::OriginalSyncMessageLikeEvent;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, UserId};
use matrix_sdk::{Client, Room};
use tokio::sync::mpsc;
use crate::RoomSubscriptions;
use trix_core::adapter::{AdapterError, Result};
use trix_core::{AdapterEvent, Verification, VerificationAction, VerificationState};

use crate::err;

type Tx = mpsc::UnboundedSender<AdapterEvent>;

/// Emoji, showing a QR code for the other device, and scanning theirs with the camera.
fn methods() -> Vec<VerificationMethod> {
    vec![VerificationMethod::SasV1, VerificationMethod::QrCodeShowV1, VerificationMethod::QrCodeScanV1, VerificationMethod::ReciprocateV1]
}

fn qr_svg(qr: &QrVerification) -> Option<String> {
    let code = qr.to_qr_code().ok()?;
    Some(code.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
}

/// Picks up verification requests from others (in a DM) and from our own other sessions.
pub(crate) fn register(client: &Client, tx: Tx, account: String, rooms: Arc<RoomSubscriptions>) {
    client.add_event_handler({
        let (tx, account, rooms) = (tx.clone(), account.clone(), rooms.clone());
        move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            let (tx, account, rooms) = (tx.clone(), account.clone(), rooms.clone());
            async move {
                if let Some(request) = client.encryption().get_verification_request(&ev.sender, &ev.content.transaction_id).await {
                    tokio::spawn(follow_request(request, tx, account, rooms));
                }
            }
        }
    });
    // In the log, for "stuck at waiting": whether the other side's answers arrive at all.
    client.add_event_handler(|ev: OriginalSyncMessageLikeEvent<KeyVerificationAcceptEventContent>, room: Room| async move {
        tracing::info!(room = %room.room_id(), sender = %ev.sender, "verification: their accept arrived");
    });
    client.add_event_handler(|ev: OriginalSyncMessageLikeEvent<KeyVerificationKeyEventContent>, room: Room| async move {
        tracing::info!(room = %room.room_id(), sender = %ev.sender, "verification: their key arrived");
    });
    client.add_event_handler(move |ev: OriginalSyncRoomMessageEvent, client: Client| {
        let (tx, account, rooms) = (tx.clone(), account.clone(), rooms.clone());
        async move {
            // Our own requests are already being followed by whoever sent them.
            if !matches!(ev.content.msgtype, MessageType::VerificationRequest(_)) || client.user_id() == Some(&*ev.sender) {
                return;
            }
            // Old requests from history come back as None: the SDK drops expired ones.
            if let Some(request) = client.encryption().get_verification_request(&ev.sender, &ev.event_id).await {
                tokio::spawn(follow_request(request, tx, account, rooms));
            }
        }
    });
}

/// Asks `user_id` (or one of our own sessions, `device_id`) to verify by emoji.
pub(crate) async fn start(client: &Client, tx: Tx, account: String, rooms: Arc<RoomSubscriptions>, user_id: &str, device_id: Option<&str>) -> Result<()> {
    let user = UserId::parse(user_id).map_err(err)?;
    let methods = methods();
    let request = match device_id {
        Some(device) => {
            let device = OwnedDeviceId::from(device);
            let device = client.encryption().get_device(&user, &device).await.map_err(err)?.ok_or_else(|| AdapterError::Other("Unknown session".into()))?;
            device.request_verification_with_methods(methods).await.map_err(err)?
        }
        None => {
            let identity = client
                .encryption()
                .get_user_identity(&user)
                .await
                .map_err(err)?
                .ok_or_else(|| AdapterError::Other("This user hasn't set up cross-signing, so they can't be verified yet".into()))?;
            identity.request_verification_with_methods(methods).await.map_err(err)?
        }
    };
    tokio::spawn(follow_request(request, tx, account, rooms));
    Ok(())
}

pub(crate) async fn act(client: &Client, user_id: &str, flow_id: &str, action: VerificationAction) -> Result<()> {
    let user = UserId::parse(user_id).map_err(err)?;
    let encryption = client.encryption();
    let gone = || AdapterError::Other("This verification has ended".into());
    let flow = encryption.get_verification(&user, flow_id).await;
    match action {
        VerificationAction::Accept => {
            let request = encryption.get_verification_request(&user, flow_id).await.ok_or_else(gone)?;
            request.accept_with_methods(methods()).await.map_err(err)
        }
        // The request's follower picks up the new emoji flow.
        VerificationAction::StartSas => {
            let request = encryption.get_verification_request(&user, flow_id).await.ok_or_else(gone)?;
            request.start_sas().await.map_err(err)?.ok_or_else(|| AdapterError::Other("The other side doesn't support emoji verification".into()))?;
            Ok(())
        }
        VerificationAction::Confirm => match flow.ok_or_else(gone)? {
            Flow::SasV1(sas) => sas.confirm().await.map_err(err),
            Flow::QrV1(qr) => qr.confirm().await.map_err(err),
            _ => Err(AdapterError::Unsupported("this verification method")),
        },
        VerificationAction::Mismatch => match flow.ok_or_else(gone)? {
            Flow::SasV1(sas) => sas.mismatch().await.map_err(err),
            Flow::QrV1(qr) => qr.cancel().await.map_err(err),
            _ => Err(AdapterError::Unsupported("this verification method")),
        },
        VerificationAction::Cancel => {
            match flow {
                Some(Flow::SasV1(sas)) => return sas.cancel().await.map_err(err),
                Some(Flow::QrV1(qr)) => return qr.cancel().await.map_err(err),
                _ => {}
            }
            match encryption.get_verification_request(&user, flow_id).await {
                Some(request) => request.cancel().await.map_err(err),
                None => Ok(()),
            }
        }
    }
}

/// Hands the scanned code to the request; its follower then picks up the QR flow.
pub(crate) async fn scan(client: &Client, user_id: &str, flow_id: &str, data: Vec<u8>) -> Result<()> {
    use matrix_sdk::encryption::verification::QrVerificationData;

    let user = UserId::parse(user_id).map_err(err)?;
    let request = client.encryption().get_verification_request(&user, flow_id).await.ok_or_else(|| AdapterError::Other("This verification has ended".into()))?;
    let data = QrVerificationData::from_bytes(data).map_err(|_| AdapterError::Other("That isn't a Matrix verification code".into()))?;
    request.scan_qr_code(data).await.map_err(err)?.ok_or_else(|| AdapterError::Other("The code doesn't match this verification".into()))?;
    Ok(())
}

/// Reports one flow's state; the device is filled in once the other side is known.
struct Reporter {
    tx: Tx,
    account: String,
    flow_id: String,
    user_id: String,
    we_started: bool,
    device: Option<(String, Option<String>)>,
}

impl Reporter {
    fn send(&self, state: VerificationState) {
        tracing::info!(flow = %self.flow_id, user = %self.user_id, device = ?self.device, we_started = self.we_started, ?state, "verification");
        let _ = self.tx.send(AdapterEvent::Verification(Verification {
            account: self.account.clone(),
            flow_id: self.flow_id.clone(),
            user_id: self.user_id.clone(),
            device_id: self.device.as_ref().map(|d| d.0.clone()),
            device_name: self.device.as_ref().and_then(|d| d.1.clone()),
            we_started: self.we_started,
            state,
        }));
    }

    fn cancelled(&self, reason: &str, by_us: bool) {
        self.send(VerificationState::Cancelled { reason: reason.to_owned(), by_us });
    }
}

/// While a verification runs in a room, sliding sync follows that room closely (see
/// `RoomSubscriptions`); it lets go when the flow ends, however it ends.
struct Following(Arc<RoomSubscriptions>, Option<OwnedRoomId>);

impl Drop for Following {
    fn drop(&mut self) {
        if let Some(room) = &self.1 {
            self.0.verifying(room, false);
        }
    }
}

async fn follow_request(request: VerificationRequest, tx: Tx, account: String, rooms: Arc<RoomSubscriptions>) {
    let room = request.room_id().map(ToOwned::to_owned);
    if let Some(room) = &room {
        rooms.verifying(room, true);
    }
    let _following = Following(rooms, room);
    let mut r = Reporter {
        tx,
        account,
        flow_id: request.flow_id().to_owned(),
        user_id: request.other_user_id().to_string(),
        we_started: request.we_started(),
        device: None,
    };
    let mut changes = request.changes();
    let mut state = request.state();
    loop {
        match state {
            VerificationRequestState::Created { .. } => r.send(VerificationState::Waiting),
            VerificationRequestState::Requested { other_device_data, .. } => {
                r.device = Some((other_device_data.device_id().to_string(), other_device_data.display_name().map(ToOwned::to_owned)));
                r.send(VerificationState::Requested);
            }
            VerificationRequestState::Ready { other_device_data, their_methods, .. } => {
                r.device = Some((other_device_data.device_id().to_string(), other_device_data.display_name().map(ToOwned::to_owned)));
                // If they can scan or show a code, offer QR next to emoji and let the user pick.
                let qr = if their_methods.contains(&VerificationMethod::QrCodeScanV1) {
                    request.generate_qr_code().await.ok().flatten().as_ref().and_then(qr_svg)
                } else {
                    None
                };
                let scan = their_methods.contains(&VerificationMethod::QrCodeShowV1);
                if qr.is_some() || scan {
                    r.send(VerificationState::Ready { qr, scan });
                    match changes.next().await {
                        Some(next) => state = next,
                        None => return,
                    }
                    continue;
                }
                // Otherwise whoever asked starts the emoji step; the other side waits for it.
                if r.we_started {
                    match request.start_sas().await {
                        Ok(Some(sas)) => return follow_sas(sas, r).await,
                        Ok(None) => return r.cancelled("The other side doesn't support emoji verification", false),
                        Err(e) => return r.cancelled(&e.to_string(), true),
                    }
                }
                r.send(VerificationState::Waiting);
            }
            VerificationRequestState::Transitioned { verification } => {
                return match verification {
                    Flow::SasV1(sas) => follow_sas(sas, r).await,
                    Flow::QrV1(qr) => follow_qr(qr, r).await,
                    _ => {
                        let _ = request.cancel().await;
                        r.cancelled("This verification method isn't supported", true)
                    }
                };
            }
            VerificationRequestState::Done => return r.send(VerificationState::Done),
            VerificationRequestState::Cancelled(info) => return r.cancelled(&format!("{} ({})", info.reason(), info.cancel_code()), info.cancelled_by_us()),
        }
        match changes.next().await {
            Some(next) => state = next,
            None => return,
        }
    }
}

async fn follow_sas(sas: SasVerification, mut r: Reporter) {
    let device = sas.other_device();
    r.device.get_or_insert_with(|| (device.device_id().to_string(), device.display_name().map(ToOwned::to_owned)));
    let mut changes = sas.changes();
    let mut state = sas.state();
    let mut accepted = false;
    loop {
        let step = match &state {
            SasState::Created { .. } => "created",
            SasState::Started { .. } => "started",
            SasState::Accepted { .. } => "accepted",
            SasState::KeysExchanged { .. } => "keys exchanged",
            SasState::Confirmed => "confirmed",
            SasState::Done { .. } => "done",
            SasState::Cancelled(_) => "cancelled",
        };
        tracing::info!(flow = %r.flow_id, step, we_started = sas.we_started(), "verification: emoji step");
        match state {
            SasState::Started { .. } if !sas.we_started() && !accepted => {
                accepted = true;
                if let Err(e) = sas.accept().await {
                    return r.cancelled(&e.to_string(), true);
                }
                r.send(VerificationState::Waiting);
            }
            SasState::Created { .. } | SasState::Started { .. } | SasState::Accepted { .. } => r.send(VerificationState::Waiting),
            SasState::KeysExchanged { emojis, decimals } => {
                let emojis = emojis.map(|e| e.emojis.iter().map(|e| (e.symbol.to_owned(), e.description.to_owned())).collect()).unwrap_or_default();
                r.send(VerificationState::Emojis { emojis, decimals });
            }
            SasState::Confirmed => r.send(VerificationState::Confirmed),
            SasState::Done { .. } => return r.send(VerificationState::Done),
            SasState::Cancelled(info) => return r.cancelled(&format!("{} ({})", info.reason(), info.cancel_code()), info.cancelled_by_us()),
        }
        match changes.next().await {
            Some(next) => state = next,
            None => return,
        }
    }
}

/// The other device scans the code we showed; we confirm once it says "verified".
async fn follow_qr(qr: QrVerification, mut r: Reporter) {
    let device = qr.other_device();
    r.device.get_or_insert_with(|| (device.device_id().to_string(), device.display_name().map(ToOwned::to_owned)));
    let mut changes = qr.changes();
    let mut state = qr.state();
    loop {
        match state {
            QrVerificationState::Started | QrVerificationState::Confirmed | QrVerificationState::Reciprocated => r.send(VerificationState::Waiting),
            QrVerificationState::Scanned => r.send(VerificationState::QrScanned),
            QrVerificationState::Done { .. } => return r.send(VerificationState::Done),
            QrVerificationState::Cancelled(info) => return r.cancelled(&format!("{} ({})", info.reason(), info.cancel_code()), info.cancelled_by_us()),
        }
        match changes.next().await {
            Some(next) => state = next,
            None => return,
        }
    }
}

