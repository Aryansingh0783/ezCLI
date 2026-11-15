//! Mutex locking that survives a panic elsewhere.
//!
//! `Mutex::lock().unwrap()` panics if another thread panicked while holding the
//! lock ("poisoned"). In a desktop app that turns one failed background task
//! into every later command failing. The data behind these locks stays valid
//! (plain maps and lists), so we take the guard back and carry on.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Lock, recovering the guard if the mutex was poisoned.
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_lock_is_still_usable() {
        let m = Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.lock().is_err(), "the lock really is poisoned");
        *m.lock_ok() += 1;
        assert_eq!(*m.lock_ok(), 2);
    }
}
