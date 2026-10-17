//! Small, read-only system facts used to guide local-versus-cloud choices.
//!
//! This deliberately reports only coarse hardware capacity. It does not read
//! files, enumerate accounts, start a model runtime, or install anything.

use serde::Serialize;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// Hardware facts that are useful when recommending an Ollama route.
///
/// `None` serializes as `null`: callers must treat an unavailable GPU/RAM
/// reading as unknown rather than assuming there is no GPU or memory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProfile {
    pub logical_cpu_cores: usize,
    pub total_memory_gib: Option<u64>,
    pub gpu_name: Option<String>,
    pub gpu_vram_mib: Option<u64>,
}

/// Collect a minimal local hardware profile. This is safe to call repeatedly
/// and does not invoke a shell or any third-party executable.
pub fn detect() -> SystemProfile {
    let logical_cpu_cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);

    #[cfg(windows)]
    let (total_memory_gib, gpu_name, gpu_vram_mib) = windows_profile();

    #[cfg(not(windows))]
    let (total_memory_gib, gpu_name, gpu_vram_mib) = (None, None, None);

    SystemProfile {
        logical_cpu_cores,
        total_memory_gib,
        gpu_name,
        gpu_vram_mib,
    }
}

fn gib_from_bytes(bytes: u64) -> Option<u64> {
    (bytes != 0).then(|| bytes.saturating_add(GIB / 2) / GIB)
}

fn mib_from_bytes(bytes: usize) -> Option<u64> {
    let bytes = bytes as u64;
    (bytes != 0).then_some(bytes / MIB)
}

#[cfg(windows)]
fn windows_profile() -> (Option<u64>, Option<String>, Option<u64>) {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::{Interface, PCSTR, PCWSTR};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::Graphics::Dxgi::{IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let total_memory_gib = unsafe {
        let mut memory = MEMORYSTATUSEX::default();
        memory.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut memory).is_ok() {
            gib_from_bytes(memory.ullTotalPhys)
        } else {
            None
        }
    };

    // Prefer the non-software adapter with the largest dedicated VRAM. That
    // naturally picks a discrete GPU over an integrated adapter where both
    // are present. DXGI calls fail closed to "unknown" on VMs and unusual
    // graphics drivers.
    let best_adapter = unsafe {
        // DXGI is dynamically loaded. A missing or old graphics runtime must
        // leave the recommendation as unknown rather than stopping ezCLI at
        // process start because of a static DLL import.
        let dxgi_name: Vec<u16> = "dxgi.dll\0".encode_utf16().collect();
        let Ok(module) = LoadLibraryW(PCWSTR(dxgi_name.as_ptr())) else {
            return (total_memory_gib, None, None);
        };
        let Some(symbol) = GetProcAddress(module, PCSTR(b"CreateDXGIFactory1\0".as_ptr())) else {
            let _ = FreeLibrary(module);
            return (total_memory_gib, None, None);
        };

        type CreateDxgiFactory1 = unsafe extern "system" fn(
            *const windows::core::GUID,
            *mut *mut c_void,
        ) -> windows::core::HRESULT;
        let create: CreateDxgiFactory1 = std::mem::transmute(symbol);
        let mut raw_factory = std::ptr::null_mut();
        let result = create(&IDXGIFactory1::IID, &mut raw_factory);
        if !result.is_ok() || raw_factory.is_null() {
            let _ = FreeLibrary(module);
            return (total_memory_gib, None, None);
        }
        let factory = IDXGIFactory1::from_raw(raw_factory);
        let mut best: Option<(String, usize)> = None;
        for index in 0..64 {
            let Ok(adapter) = factory.EnumAdapters1(index) else {
                break;
            };
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }

            let nul = desc
                .Description
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..nul])
                .trim()
                .to_owned();
            if name.is_empty() {
                continue;
            }

            if best
                .as_ref()
                .map_or(true, |(_, vram)| desc.DedicatedVideoMemory > *vram)
            {
                best = Some((name, desc.DedicatedVideoMemory));
            }
        }
        // The COM object must release its vtable before dxgi.dll is unloaded.
        drop(factory);
        let _ = FreeLibrary(module);
        best
    };

    match best_adapter {
        Some((name, vram)) => (total_memory_gib, Some(name), mib_from_bytes(vram)),
        None => (total_memory_gib, None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_ram_to_the_nearest_gib() {
        assert_eq!(gib_from_bytes(0), None);
        assert_eq!(gib_from_bytes(GIB), Some(1));
        assert_eq!(gib_from_bytes(GIB + GIB / 2 - 1), Some(1));
        assert_eq!(gib_from_bytes(GIB + GIB / 2), Some(2));
    }

    #[test]
    fn keeps_gpu_vram_in_mib() {
        assert_eq!(mib_from_bytes(0), None);
        assert_eq!(mib_from_bytes((12 * 1024 * 1024) as usize), Some(12));
    }

    #[test]
    fn profile_always_has_a_cpu_count() {
        assert!(detect().logical_cpu_cores >= 1);
    }
}
