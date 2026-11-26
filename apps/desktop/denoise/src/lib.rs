//! DeepFilterNet 3 for the call's microphone, with a plain C interface: the AudioWorklet that
//! runs it has no JavaScript glue (and no TextDecoder in WebKit's worklet scope), only
//! WebAssembly exports and the module's memory.
//!
//!   const st = dn_create(100);           // attenuation limit in dB (100: as much as it can)
//!   const n = dn_frame_length(st);       // 480 samples, 10 ms at 48 kHz
//!   new Float32Array(memory.buffer, dn_input(st), n).set(frame);
//!   dn_process(st);                      // the cleaned frame is at dn_output(st)
//!
//! The output trails the input by the model's look-ahead (two frames) plus one frame.

use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

fn no_random(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_random);

pub struct Denoiser {
    model: DfTract,
    input: Vec<f32>,
    output: Vec<f32>,
}

/// A denoiser for one microphone, or null if the model couldn't be loaded.
#[no_mangle]
pub extern "C" fn dn_create(atten_lim_db: f32) -> *mut Denoiser {
    let params = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim_db);
    match DfTract::new(DfParams::default(), &params) {
        Ok(model) => {
            let n = model.hop_size;
            Box::into_raw(Box::new(Denoiser { model, input: vec![0.; n], output: vec![0.; n] }))
        }
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_free(st: *mut Denoiser) {
    if !st.is_null() {
        drop(Box::from_raw(st));
    }
}

/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_frame_length(st: *mut Denoiser) -> usize {
    (*st).model.hop_size
}

/// Where the next frame goes in, `dn_frame_length` samples.
///
/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_input(st: *mut Denoiser) -> *mut f32 {
    (*st).input.as_mut_ptr()
}

/// Where the cleaned frame comes out after dn_process.
///
/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_output(st: *mut Denoiser) -> *mut f32 {
    (*st).output.as_mut_ptr()
}

/// Cleans the frame at dn_input into dn_output; returns the frame's estimated speech-to-noise
/// ratio in dB, or NaN if processing failed (the output is then the input as it was).
///
/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_process(st: *mut Denoiser) -> f32 {
    let d = &mut *st;
    let n = d.model.hop_size;
    let input = ArrayView2::from_shape((1, n), &d.input[..]).unwrap();
    let output = ArrayViewMut2::from_shape((1, n), &mut d.output[..]).unwrap();
    match d.model.process(input, output) {
        Ok(snr) => snr,
        Err(_) => {
            d.output.copy_from_slice(&d.input);
            f32::NAN
        }
    }
}

/// How far noise may be turned down, in dB (lower keeps more of the room).
///
/// # Safety
/// `st` comes from dn_create and wasn't freed.
#[no_mangle]
pub unsafe extern "C" fn dn_set_atten_lim(st: *mut Denoiser, db: f32) {
    (*st).model.set_atten_lim(db);
}
