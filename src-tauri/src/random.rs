//! Names nothing else on this computer could work out: a ticket of the media scheme, the name a
//! file is written under until it is whole. From the system's own generator, never from a count,
//! the clock or an address.

/// Fill `out` from the system's generator.
#[cfg(unix)]
fn from_system(out: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")?.read_exact(out)
}

#[cfg(not(unix))]
fn from_system(_out: &mut [u8]) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "the system's generator is not read here",
    ))
}

/// Where the system's generator cannot be read: the standard library's hasher keys, which it
/// seeds from that same generator, once for this process.
fn from_std(out: &mut [u8]) {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    for (n, chunk) in out.chunks_mut(8).enumerate() {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_usize(n);
        let word = hasher.finish().to_le_bytes();
        chunk.copy_from_slice(&word[..chunk.len()]);
    }
}

/// `bytes` random bytes, as lower-case hex (twice as many characters).
pub fn hex(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    if from_system(&mut raw).is_err() {
        from_std(&mut raw);
    }
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_hex_of_the_length_asked_and_never_the_same_twice() {
        let a = hex(16);
        let b = hex(16);
        assert_eq!(a.len(), 32);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(a, b);
        assert_eq!(hex(0), "");
        // The fallback fills every byte asked for, whatever the length.
        let mut odd = [0u8; 13];
        from_std(&mut odd);
        let mut again = [0u8; 13];
        from_std(&mut again);
        assert_ne!(odd, again);
        #[cfg(unix)]
        {
            let mut raw = [0u8; 32];
            from_system(&mut raw).unwrap();
            assert_ne!(raw, [0u8; 32]);
        }
    }
}
