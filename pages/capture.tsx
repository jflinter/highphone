// /capture — private, unlisted data-collection tool (noindex, unlinked).
//
// Records the RAW devicemotion + deviceorientation streams for one gesture so
// real-world throws can be annotated and later replayed as fixtures against the
// (otherwise untestable) detector. See AGENTS.md and lib/detectThrow.ts.
//
// It also mirrors the game's exact detection pipeline live, so you can see
// whether the real game *would* have recorded what you just did — the ground
// truth needed to chase "high/spinny throws sometimes don't record".

import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import IPhoneOnly from '@/components/IPhoneOnly';
import {
  detectThrow,
  handleMotionRosettaCode,
  type Orientation,
  type Throw,
  type Vec3,
} from '@/lib/detectThrow';
import { CaptureSummary, createCapture, fetchCaptures } from '@/lib/api';

interface DeviceMotionEventiOS extends DeviceMotionEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}
interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// Raw, unrounded samples — a strict superset of what the game keeps (it stores
// only the derived zAccel scalar). Timestamps + interval let a replay reproduce
// the game bit-for-bit and let us finally check the hard-coded 60Hz assumption.
type MotionSample = {
  t: number;
  interval: number;
  ax: number | null;
  ay: number | null;
  az: number | null;
  gx: number | null;
  gy: number | null;
  gz: number | null;
};
type OrientationSample = {
  t: number;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};

// Mirror of the game's detection window (pages/index.tsx): 60Hz * 3.5s = 210.
const orientationEventsPerSecond = 60;
const windowSizeSeconds = 3.5;
const maxWindowSize = orientationEventsPerSecond * windowSizeSeconds;

// The game's minimum-throw gate (pages/index.tsx): totalHeight > 1.5.
const MIN_THROW_HEIGHT_FT = 1.5;

// Same rounding the game applies before feeding the detector.
const round = (v: number | null | undefined) => Number((v ?? 0).toFixed(1));

const Button = ({
  text,
  onClick,
  disabled,
}: {
  text: string;
  onClick?: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!!disabled}
    className="rounded-md px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm bg-black disabled:opacity-40"
  >
    {text}
  </button>
);

type Phase = 'idle' | 'recording' | 'stopped';

function Capture() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [sampleCount, setSampleCount] = useState(0);
  const [verdict, setVerdict] = useState<Throw | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmittedId, setLastSubmittedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<CaptureSummary[]>([]);

  // Raw session recording (grows unbounded for the whole gesture).
  const motionRef = useRef<MotionSample[]>([]);
  const orientationRef = useRef<OrientationSample[]>([]);
  const startedAtRef = useRef<string>('');
  // Detection mirror (210-sample ring buffers, exactly like the game).
  const accelBufRef = useRef<number[]>([]);
  const orientBufRef = useRef<Orientation[]>([]);
  const firstDetectionRef = useRef<Throw | null>(null);
  // Live listeners, kept so we can detach them.
  const motionListenerRef = useRef<((e: DeviceMotionEvent) => void) | null>(
    null
  );
  const orientationListenerRef = useRef<
    ((e: DeviceOrientationEvent) => void) | null
  >(null);

  const refreshRecent = () => {
    fetchCaptures().then(setRecent);
  };
  useEffect(() => {
    refreshRecent();
    return () => detachListeners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detachListeners = () => {
    if (motionListenerRef.current) {
      window.removeEventListener('devicemotion', motionListenerRef.current);
      motionListenerRef.current = null;
    }
    if (orientationListenerRef.current) {
      window.removeEventListener(
        'deviceorientation',
        orientationListenerRef.current
      );
      orientationListenerRef.current = null;
    }
  };

  const resetBuffers = () => {
    motionRef.current = [];
    orientationRef.current = [];
    accelBufRef.current = [];
    orientBufRef.current = [];
    firstDetectionRef.current = null;
  };

  const requestPermission = async (): Promise<boolean> => {
    try {
      const motion = DeviceMotionEvent as unknown as DeviceMotionEventiOS;
      const orient =
        DeviceOrientationEvent as unknown as DeviceOrientationEventiOS;
      if (typeof motion.requestPermission === 'function') {
        if ((await motion.requestPermission()) !== 'granted') return false;
      }
      if (typeof orient.requestPermission === 'function') {
        if ((await orient.requestPermission()) !== 'granted') return false;
      }
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  const startCapture = async () => {
    setError(null);
    const granted = await requestPermission();
    if (!granted) {
      setError('Motion permission denied. Reload and allow motion access.');
      return;
    }
    resetBuffers();
    setSampleCount(0);
    setVerdict(null);
    setLastSubmittedId(null);
    startedAtRef.current = new Date().toISOString();

    const orientationListener = (event: DeviceOrientationEvent) => {
      orientationRef.current.push({
        t: Math.round(event.timeStamp),
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
      });
      // Detection mirror: default nulls to 0, ring-buffer at maxWindowSize.
      orientBufRef.current.push({
        alpha: event.alpha ?? 0,
        beta: event.beta ?? 0,
        gamma: event.gamma ?? 0,
      });
      if (orientBufRef.current.length > maxWindowSize) {
        orientBufRef.current.shift();
      }
    };

    const motionListener = (event: DeviceMotionEvent) => {
      // Raw record (full precision, unrounded).
      motionRef.current.push({
        t: Math.round(event.timeStamp),
        interval: event.interval,
        ax: event.acceleration?.x ?? null,
        ay: event.acceleration?.y ?? null,
        az: event.acceleration?.z ?? null,
        gx: event.accelerationIncludingGravity?.x ?? null,
        gy: event.accelerationIncludingGravity?.y ?? null,
        gz: event.accelerationIncludingGravity?.z ?? null,
      });

      // Detection mirror — identical to the game's motionListener pipeline.
      const acceleration: Vec3 = [
        round(event.acceleration?.x),
        round(event.acceleration?.y),
        round(event.acceleration?.z),
      ];
      const accelerationIncludingGravity: Vec3 = [
        round(event.accelerationIncludingGravity?.x),
        round(event.accelerationIncludingGravity?.y),
        round(event.accelerationIncludingGravity?.z),
      ];
      const gravityVector: Vec3 = [
        accelerationIncludingGravity[0] - acceleration[0],
        accelerationIncludingGravity[1] - acceleration[1],
        accelerationIncludingGravity[2] - acceleration[2],
      ];
      const rotatedAcceleration = handleMotionRosettaCode(
        acceleration,
        gravityVector
      );
      const zAccel = rotatedAcceleration[2] * -1;
      accelBufRef.current.push(zAccel);
      if (accelBufRef.current.length > maxWindowSize) {
        accelBufRef.current.shift();
      }

      const detected = detectThrow(accelBufRef.current, orientBufRef.current);
      if (detected && !firstDetectionRef.current) {
        firstDetectionRef.current = detected;
      }
      setSampleCount(motionRef.current.length);
    };

    motionListenerRef.current = motionListener;
    orientationListenerRef.current = orientationListener;
    window.addEventListener('deviceorientation', orientationListener);
    window.addEventListener('devicemotion', motionListener);
    setPhase('recording');
  };

  const stopCapture = () => {
    detachListeners();
    setVerdict(firstDetectionRef.current);
    setPhase('stopped');
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const detection = firstDetectionRef.current;
    const data = JSON.stringify({
      version: 1,
      startedAt: startedAtRef.current,
      endedAt: new Date().toISOString(),
      motion: motionRef.current,
      orientation: orientationRef.current,
    });
    const id = await createCapture({
      notes,
      data,
      detected: !!detection,
      durationMs: detection ? detection.durationMs : null,
      sampleCount: motionRef.current.length,
    });
    setSubmitting(false);
    if (id === null) {
      setError('Submit failed — check the console / network.');
      return;
    }
    setLastSubmittedId(id);
    setNotes('');
    setVerdict(null);
    resetBuffers();
    setSampleCount(0);
    setPhase('idle');
    refreshRecent();
  };

  // "Would the game have recorded this?" mirrors the game's gate.
  const renderVerdict = () => {
    if (!verdict) {
      return <span className="text-red-600">No throw detected ✕</span>;
    }
    const seconds = (verdict.durationMs / 1000).toFixed(2);
    const feet = verdict.totalHeight.toFixed(1);
    if (verdict.totalHeight > MIN_THROW_HEIGHT_FT) {
      return (
        <span className="text-green-600">
          Detected & recorded ✓ — {seconds}s, {feet}ft
        </span>
      );
    }
    return (
      <span className="text-amber-600">
        Detected but below the {MIN_THROW_HEIGHT_FT}ft gate (would NOT record) —{' '}
        {seconds}s, {feet}ft
      </span>
    );
  };

  return (
    <main className="flex w-full flex-col items-center px-6 py-6 space-y-6 max-w-md mx-auto">
      <div className="w-full flex items-center justify-between">
        <Link href="/" className="text-blue-600">
          ← Home
        </Link>
        <h1 className="text-xl font-semibold">capture</h1>
        <div className="w-[52px]">&nbsp;</div>
      </div>

      <p className="text-sm text-gray-600 text-center">
        Start a capture, do one throw (or gesture), stop, annotate, and submit.
        Records the raw sensor trace + whether the real game would record it.
      </p>

      <div className="flex flex-col items-center space-y-3 w-full">
        {phase === 'idle' && (
          <Button text="Start capture ▶️" onClick={startCapture} />
        )}
        {phase === 'recording' && (
          <>
            <div className="text-sm text-gray-600 animate-pulse">
              recording… {sampleCount} motion samples
            </div>
            <Button text="Stop ⏹️" onClick={stopCapture} />
          </>
        )}
        {phase === 'stopped' && (
          <div className="w-full flex flex-col items-center space-y-3">
            <div className="text-sm">{renderVerdict()}</div>
            <div className="text-xs text-gray-500">
              {motionRef.current.length} motion / {orientationRef.current.length}{' '}
              orientation samples
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='e.g. "super high throw with lots of spin"'
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
              rows={3}
            />
            <div className="flex space-x-3">
              <Button
                text={submitting ? 'Submitting…' : 'Submit'}
                onClick={submit}
                disabled={submitting}
              />
              <Button
                text="Discard"
                onClick={() => {
                  resetBuffers();
                  setNotes('');
                  setVerdict(null);
                  setSampleCount(0);
                  setPhase('idle');
                }}
              />
            </div>
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}
        {lastSubmittedId !== null && (
          <div className="text-sm text-green-600">
            Saved as capture #{lastSubmittedId} ✓
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="w-full">
          <h2 className="text-sm font-semibold mb-2">Recent captures</h2>
          <ul className="text-xs text-gray-600 space-y-1">
            {recent.map((c) => (
              <li key={c.id} className="flex justify-between gap-2">
                <span className="truncate">
                  #{c.id} {c.detected ? '✓' : '✕'} {c.notes || <em>(no note)</em>}
                </span>
                <span className="whitespace-nowrap text-gray-400">
                  {c.sample_count ?? '?'} smp
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

export default function CapturePage() {
  const router = useRouter();
  return (
    <>
      <Head>
        <meta name="robots" content="noindex" />
        <title>capture · high phone</title>
      </Head>
      <IPhoneOnly
        fallback={
          <main className="flex w-full flex-col items-center px-6 py-10 space-y-4 text-center">
            <p>The capture tool needs an iPhone&apos;s motion sensors.</p>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="text-blue-600"
            >
              ← Home
            </button>
          </main>
        }
      >
        <Capture />
      </IPhoneOnly>
    </>
  );
}
