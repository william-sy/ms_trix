//! Speaker choice on macOS. WebKit there can't send a page's sound to a chosen device
//! (no `setSinkId`), so the call screen picks the Mac's sound output instead, through
//! CoreAudio (the same as choosing it in Control Centre).

#[derive(serde::Serialize)]
pub struct AudioOutput {
    id: u32,
    name: String,
    current: bool,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::AudioOutput;
    use std::ffi::c_void;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const fn code(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }
    const SYSTEM: u32 = 1;
    const DEVICES: u32 = code(b"dev#");
    const DEFAULT_OUTPUT: u32 = code(b"dOut");
    const NAME: u32 = code(b"lnam");
    const STREAMS: u32 = code(b"stm#");
    const GLOBAL: u32 = code(b"glob");
    const OUTPUT: u32 = code(b"outp");
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyDataSize(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
        fn AudioObjectGetPropertyData(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
        fn AudioObjectSetPropertyData(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: u32, data: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(s: *const c_void, buffer: *mut u8, size: isize, encoding: u32) -> bool;
        fn CFRelease(object: *const c_void);
    }

    fn size_of(object: u32, address: &Address) -> Option<u32> {
        let mut size = 0;
        (unsafe { AudioObjectGetPropertyDataSize(object, address, 0, std::ptr::null(), &mut size) } == 0).then_some(size)
    }

    fn default_output() -> Option<u32> {
        let address = Address { selector: DEFAULT_OUTPUT, scope: GLOBAL, element: 0 };
        let (mut id, mut size) = (0u32, 4u32);
        (unsafe { AudioObjectGetPropertyData(SYSTEM, &address, 0, std::ptr::null(), &mut size, (&mut id as *mut u32).cast()) } == 0).then_some(id)
    }

    fn name(device: u32) -> Option<String> {
        let address = Address { selector: NAME, scope: GLOBAL, element: 0 };
        let mut s: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        if unsafe { AudioObjectGetPropertyData(device, &address, 0, std::ptr::null(), &mut size, (&mut s as *mut *const c_void).cast()) } != 0 || s.is_null() {
            return None;
        }
        let mut buffer = [0u8; 256];
        let ok = unsafe { CFStringGetCString(s, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        unsafe { CFRelease(s) };
        ok.then(|| String::from_utf8_lossy(&buffer[..buffer.iter().position(|&b| b == 0).unwrap_or(0)]).into_owned())
    }

    pub fn outputs() -> Vec<AudioOutput> {
        let address = Address { selector: DEVICES, scope: GLOBAL, element: 0 };
        let Some(mut size) = size_of(SYSTEM, &address) else { return vec![] };
        let mut ids = vec![0u32; size as usize / 4];
        if unsafe { AudioObjectGetPropertyData(SYSTEM, &address, 0, std::ptr::null(), &mut size, ids.as_mut_ptr().cast()) } != 0 {
            return vec![];
        }
        let current = default_output();
        ids.into_iter()
            // Only devices that can play sound (they have output streams).
            .filter(|&id| size_of(id, &Address { selector: STREAMS, scope: OUTPUT, element: 0 }).is_some_and(|s| s > 0))
            .filter_map(|id| Some(AudioOutput { id, name: name(id)?, current: Some(id) == current }))
            .collect()
    }

    pub fn set_output(id: u32) -> Result<(), String> {
        let address = Address { selector: DEFAULT_OUTPUT, scope: GLOBAL, element: 0 };
        match unsafe { AudioObjectSetPropertyData(SYSTEM, &address, 0, std::ptr::null(), 4, (&id as *const u32).cast()) } {
            0 => Ok(()),
            status => Err(format!("could not switch the sound output ({status})")),
        }
    }
}

#[tauri::command]
pub fn audio_outputs() -> Vec<AudioOutput> {
    #[cfg(target_os = "macos")]
    return mac::outputs();
    #[cfg(not(target_os = "macos"))]
    return vec![];
}

#[tauri::command]
pub fn set_audio_output(id: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::set_output(id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("not available here".into())
    }
}
