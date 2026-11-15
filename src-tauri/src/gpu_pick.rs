//! Which GPU llama.cpp should run on. The Vulkan build of llama.cpp uses every graphics device it finds,
//! and with a built-in GPU next to a graphics card it spreads the model over both, so generation runs at the
//! speed of the slower one. `llama-cli --list-devices` names them; this picks the card and leaves the rest out.

/// One line of `--list-devices`: `  Vulkan0: NVIDIA GeForce RTX 5070 (12227 MiB, 11000 MiB free)`.
#[derive(Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub mib: u64,
}

pub fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (id, rest) = line.split_once(": ")?;
            if id.contains(' ') || !id.chars().last()?.is_ascii_digit() || !id.chars().next()?.is_ascii_alphabetic() {
                return None;
            }
            let open = rest.rfind(" (")?;
            let name = rest[..open].trim().to_string();
            let mib: u64 = rest[open + 2..].split(" MiB").next()?.trim().parse().ok()?;
            Some(Device { id: id.to_string(), name, mib })
        })
        .collect()
}

/// A graphics chip inside the processor shares main memory and is several times slower than a card.
fn is_integrated(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let card = n.contains("geforce") || n.contains("nvidia") || n.contains("rtx") || n.contains("gtx") || n.contains("quadro")
        || n.contains("radeon rx") || n.contains("radeon pro") || n.contains("radeon vii") || n.contains(" arc ") || n.starts_with("intel(r) arc");
    !card
}

/// The device to pass as `--device`, only when there is a real choice (more than one device).
pub fn pick(devices: &[Device]) -> Option<&Device> {
    if devices.len() < 2 {
        return None;
    }
    devices.iter().max_by_key(|d| (!is_integrated(&d.name), d.mib))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "ggml_vulkan: Found 2 Vulkan devices:\nAvailable devices:\n  Vulkan0: AMD Radeon(TM) Graphics (16384 MiB, 15000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 5070 (12227 MiB, 11000 MiB free)\n";

    #[test]
    fn devices_are_read_from_the_list() {
        let d = parse_devices(OUT);
        assert_eq!(d.len(), 2);
        assert_eq!(d[1], Device { id: "Vulkan1".into(), name: "NVIDIA GeForce RTX 5070".into(), mib: 12227 });
    }

    #[test]
    fn the_card_beats_the_built_in_gpu_even_with_less_memory() {
        let d = parse_devices(OUT);
        assert_eq!(pick(&d).unwrap().id, "Vulkan1");
    }

    #[test]
    fn one_device_means_no_choice_and_two_cards_take_the_bigger() {
        assert!(pick(&parse_devices("  Vulkan0: NVIDIA GeForce RTX 5070 (12227 MiB, 1 MiB free)")).is_none());
        let two = "  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 1 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4090 (24564 MiB, 1 MiB free)";
        assert_eq!(pick(&parse_devices(two)).unwrap().id, "Vulkan1");
    }
}
