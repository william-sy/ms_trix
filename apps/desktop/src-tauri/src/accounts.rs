//! Persists the account list (plain JSON, no secrets) and each account's
//! session blob (OS keychain: access token + local store passphrase).

use std::path::{Path, PathBuf};

use trix_core::{Account, AccountId};

const KEYCHAIN_SERVICE: &str = "ms_trix";

fn list_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts.json")
}

pub fn load(data_dir: &Path) -> Vec<Account> {
    std::fs::read(list_path(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(data_dir: &Path, accounts: &[Account]) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    std::fs::write(list_path(data_dir), serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn add(data_dir: &Path, account: &Account, session: &[u8]) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account.id.0)
        .and_then(|e| e.set_secret(session))
        .map_err(|e| format!("could not store session in keychain: {e}"))?;
    let mut accounts = load(data_dir);
    accounts.retain(|a| a.id != account.id);
    accounts.push(account.clone());
    save(data_dir, &accounts)
}

/// Updates the stored profile (name, avatar) without touching the session.
pub fn update_profile(data_dir: &Path, account: &Account) -> Result<(), String> {
    let mut accounts = load(data_dir);
    let Some(stored) = accounts.iter_mut().find(|a| a.id == account.id) else { return Ok(()) };
    *stored = account.clone();
    save(data_dir, &accounts)
}

/// Replaces the stored session (e.g. after a token refresh).
pub fn update_session(account: &AccountId, session: &[u8]) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account.0)
        .and_then(|e| e.set_secret(session))
        .map_err(|e| format!("could not store session in keychain: {e}"))
}

pub fn session(account: &AccountId) -> Result<Vec<u8>, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account.0)
        .and_then(|e| e.get_secret())
        .map_err(|e| format!("could not read session from keychain: {e}"))
}

/// Key of the local search index, made on first use. Losing it only means re-indexing.
pub fn search_key() -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, "search-index").map_err(|e| e.to_string())?;
    match entry.get_secret() {
        Ok(key) if key.len() == 32 => Ok(key),
        _ => {
            let key: [u8; 32] = rand::random();
            entry.set_secret(&key).map_err(|e| format!("could not store search key in keychain: {e}"))?;
            Ok(key.to_vec())
        }
    }
}

pub fn remove(data_dir: &Path, account: &AccountId) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &account.0) {
        let _ = entry.delete_credential();
    }
    let mut accounts = load(data_dir);
    accounts.retain(|a| &a.id != account);
    save(data_dir, &accounts)?;
    let _ = std::fs::remove_dir_all(data_dir.join("accounts").join(&account.0));
    Ok(())
}
