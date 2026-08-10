// Keeps the screen awake while the game / capture tool is on screen.
//
// NOT part of the frozen detection logic (see AGENTS.md) — this touches nothing
// the detector reads. It only affects whether iOS's idle timer locks the phone
// mid-session, which suspends the page and stops the devicemotion stream
// outright. Capture session #5 is what that looks like: a 4765ms hole in BOTH
// sensor streams starting mid-flight, so the landing spike was never recorded
// and detectThrow could never leave `in_flight`.
//
// ⚠️ A wake lock only defeats the *idle timer*. It cannot stop the screen
// locking from a physical side-button press — including the side button being
// pressed by the phone hitting the ground, which is the likeliest cause of #5.
// This is a partial mitigation, not a fix for that case.
//
// The WakeLock types are declared locally: TypeScript 5.0.4's lib.dom does not
// ship them yet.

import { useEffect } from 'react';

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
};

/**
 * Holds a screen wake lock for as long as the calling component is mounted.
 * No-ops on browsers without the API (Safari has it from iOS 16.4).
 */
export const useWakeLock = () => {
  useEffect(() => {
    const nav = navigator as WakeLockNavigator;
    const wakeLock = nav.wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled) return;
      // The request rejects outright if the page isn't visible.
      if (document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      try {
        const next = await wakeLock.request('screen');
        if (cancelled) {
          next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // NotAllowedError — low power mode, page hidden, user setting. The game
        // still works, it's just interruptible. Nothing to surface.
      }
    };

    // iOS drops the lock whenever the page is hidden (lock screen, app switch,
    // tab change) and does NOT restore it on return — so re-acquire each time.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, []);
};
