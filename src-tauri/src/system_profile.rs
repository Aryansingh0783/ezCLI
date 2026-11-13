//! Small, read-only system facts used to guide local-versus-cloud choices.
//!
//! This deliberately reports only coarse hardware capacity. It does not read
//! files, enumerate accounts, start a model runtime, or install anything.

use serde::Serialize;

#[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
const MIB: u64 = 1024 * 1024;
#[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
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

/// Collect a minimal local hardware profile. This is safe to call repeatedly. On Windows it reads system
/// APIs; on Linux it reads `/proc` and `/sys` and, when an NVIDIA driver is installed, asks `nvidia-smi` for
/// the card's name and memory (read-only, a few seconds at most).
pub fn detect() -> SystemProfile {
    let logical_cpu_cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);

    #[cfg(windows)]
    let (total_memory_gib, gpu_name, gpu_vram_mib) = windows_profile();

    #[cfg(target_os = "linux")]
    let (total_memory_gib, gpu_name, gpu_vram_mib) = linux_profile();

    #[cfg(target_os = "macos")]
    let (total_memory_gib, gpu_name, gpu_vram_mib) = macos_profile();

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let (total_memory_gib, gpu_name, gpu_vram_mib): (Option<u64>, Option<String>, Option<u64>) = (None, None, None);

    SystemProfile {
        logical_cpu_cores,
        total_memory_gib,
        gpu_name,
        gpu_vram_mib,
    }
}

/// `MemTotal:  32768000 kB` from `/proc/meminfo`, in whole GiB.
#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(text: &str) -> Option<u64> {
    let kb: u64 = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?.split_whitespace().next()?.parse().ok()?;
    gib_from_bytes(kb.saturating_mul(1024))
}

/// First line of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: the card and its MiB.
#[cfg(any(target_os = "linux", test))]
fn parse_nvidia_smi(text: &str) -> Option<(String, u64)> {
    let mut best: Option<(String, u64)> = None;
    for line in text.lines() {
        let (name, mem) = line.rsplit_once(',')?;
        let mib: u64 = mem.trim().parse().ok()?;
        if !name.trim().is_empty() && best.as_ref().map_or(true, |b| mib > b.1) {
            best = Some((name.trim().to_string(), mib));
        }
    }
    best
}

/// macOS: RAM from `sysctl`. Apple Silicon shares that memory with its GPU ("unified"), so the GPU has no
/// memory figure of its own: callers see a GPU name and no VRAM, and size models against RAM.
#[cfg(target_os = "macos")]
fn macos_profile() -> (Option<u64>, Option<String>, Option<u64>) {
    let ram = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .and_then(gib_from_bytes);
    let gpu = (std::env::consts::ARCH == "aarch64").then(|| "Apple Silicon (unified memory)".to_string());
    (ram, gpu, None)
}

#[cfg(target_os = "linux")]
fn linux_profile() -> (Option<u64>, Option<String>, Option<u64>) {
    let ram = std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| parse_meminfo(&t));
    if let Some((name, mib)) = nvidia_gpu() {
        return (ram, Some(name), Some(mib));
    }
    // AMD (and some Intel) cards report their memory in sysfs, in bytes
    let mut best: Option<u64> = None;
    if let Ok(rd) = std::fs::read_dir("/sys/class/drm") {
        for e in rd.flatten() {
            let bytes = std::fs::read_to_string(e.path().join("device/mem_info_vram_total")).ok().and_then(|t| t.trim().parse::<u64>().ok());
            if let Some(b) = bytes {
                best = best.max(Some(b));
            }
        }
    }
    match best.and_then(|b| mib_from_bytes(b as usize)) {
        Some(mib) => (ram, Some("AMD GPU".to_string()), Some(mib)),
        None => (ram, None, None),
    }
}

#[cfg(target_os = "linux")]
fn nvidia_gpu() -> Option<(String, u64)> {
    use std::process::{Command, Stdio};
    use std::time::Duration;
    let exe = crate::agents::resolve_command("nvidia-smi")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(exe)
            .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()));
    });
    parse_nvidia_smi(&rx.recv_timeout(Duration::from_secs(4)).ok()??)
}

#[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
fn gib_from_bytes(bytes: u64) -> Option<u64> {
    (bytes != 0).then(|| bytes.saturating_add(GIB / 2) / GIB)
}

#[cfg(any(windows, target_os = "linux", test))]
fn mib_from_bytes(bytes: usize) -> Option<u64> {
    let bytes = bytes as u64;
    (bytes != 0).then_some(bytes / MIB)
}

#[cfg(windows)]
fn windows_profile() -> (Option<u64>, Option<String>, Option<u64>) {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::Graphics::Dxgi::{IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let total_memory_gib = unsafe {
        let mut memory = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
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
        let Some(symbol) = GetProcAddress(module, windows::core::s!("CreateDXGIFactory1")) else {
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

/// How much of the graphics card's own memory is in use right now, by every program together.
/// A model that needs more than what is left still loads, but part of it lands in system memory and
/// it then runs several times slower; this is what lets the app say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMemory {
    pub used_mib: u64,
    pub total_mib: u64,
}

/// `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`: one line per card.
/// The card with the most memory is the one models run on.
#[cfg_attr(not(any(windows, target_os = "linux", test)), allow(dead_code))]
fn parse_gpu_memory(text: &str) -> Option<GpuMemory> {
    let mut best: Option<GpuMemory> = None;
    for line in text.lines() {
        let Some((used, total)) = line.split_once(',') else { continue };
        let (Ok(used_mib), Ok(total_mib)) = (used.trim().parse::<u64>(), total.trim().parse::<u64>()) else { continue };
        if total_mib > 0 && best.as_ref().map_or(true, |b| total_mib > b.total_mib) {
            best = Some(GpuMemory { used_mib: used_mib.min(total_mib), total_mib });
        }
    }
    best
}

/// Current GPU memory use. NVIDIA only (it asks `nvidia-smi`, which the driver installs); `None` for
/// other cards, when the tool is missing, or when it does not answer within three seconds.
#[cfg(any(windows, target_os = "linux"))]
pub fn gpu_memory() -> Option<GpuMemory> {
    use std::process::{Command, Stdio};
    use std::time::Duration;
    let exe = crate::agents::resolve_command("nvidia-smi").map(std::path::PathBuf::from).or_else(|| {
        // the driver puts it in System32, which a GUI app's PATH can lack
        let p = std::path::PathBuf::from(std::env::var_os("SystemRoot")?).join("System32").join("nvidia-smi.exe");
        p.is_file().then_some(p)
    })?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new(exe);
        cmd.args(["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]).stdin(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        let _ = tx.send(cmd.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()));
    });
    parse_gpu_memory(&rx.recv_timeout(Duration::from_secs(3)).ok()??)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn gpu_memory() -> Option<GpuMemory> {
    None
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

    #[test]
    fn linux_memory_and_gpu_text_is_read() {
        assert_eq!(parse_meminfo("MemFree: 1 kB\nMemTotal:       32768000 kB\n"), Some(31));
        assert_eq!(parse_meminfo("nothing"), None);
        assert_eq!(parse_nvidia_smi("NVIDIA GeForce RTX 4070, 12282\n"), Some(("NVIDIA GeForce RTX 4070".to_string(), 12282)));
        assert_eq!(parse_nvidia_smi("A, 8192\nB, 24576\n"), Some(("B".to_string(), 24576)));
        assert_eq!(parse_nvidia_smi("No devices were found"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_linux_machine_reports_its_memory() {
        let p = detect();
        assert!(p.total_memory_gib.is_some_and(|g| g >= 1), "RAM was not read from /proc/meminfo: {p:?}");
    }
}

#[cfg(test)]
mod gpu_memory_tests {
    use super::*;

    #[test]
    fn used_and_total_are_read_and_the_largest_card_wins() {
        assert_eq!(parse_gpu_memory("10874, 12227\n"), Some(GpuMemory { used_mib: 10874, total_mib: 12227 }));
        assert_eq!(parse_gpu_memory("300, 4096\n9000, 24564\n"), Some(GpuMemory { used_mib: 9000, total_mib: 24564 }));
    }

    #[test]
    fn junk_an_empty_answer_and_impossible_numbers_are_handled() {
        assert_eq!(parse_gpu_memory(""), None);
        assert_eq!(parse_gpu_memory("No devices were found\n"), None);
        assert_eq!(parse_gpu_memory("[N/A], [N/A]\n"), None);
        assert_eq!(parse_gpu_memory("0, 0\n"), None);
        assert_eq!(parse_gpu_memory("99999, 8192\n").unwrap().used_mib, 8192, "use never reads as more than the card has");
    }
}
