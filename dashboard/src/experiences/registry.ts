import type { ComponentType } from "react";
import type { EEGData } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Experience registry — community contributors: add your experience here!
//
// 1. Create a component in this folder (e.g. MyExperience.tsx)
//    Props must extend ExperienceProps: { eegData, yScale, onExit }
// 2. Add an entry to EXPERIENCES below
// 3. That's it — it shows up in the gallery automatically
// ─────────────────────────────────────────────────────────────────────────────

/** Props every experience component receives. */
export interface ExperienceProps {
  eegData: EEGData;
  yScale: number;
  onExit: () => void;
  /** Optional: send a command to the pieeg-server WebSocket. */
  sendCommand?: (cmd: Record<string, unknown>) => void;
}

export interface ExperienceEntry {
  id: string;
  name: string;
  description: string;
  /** Short tag shown on the card (e.g. "VR", "3D", "2D") */
  tag: string;
  /** Gradient colours for the card thumbnail placeholder */
  gradient: [string, string];
  /** The component to render when this experience is launched */
  component: ComponentType<ExperienceProps>;
  /** Whether VR headset is supported */
  vr?: boolean;
  /** Whether hand tracking is supported */
  handTracking?: boolean;
  /** Author / contributor name */
  author?: string;
}

// Lazy-load to keep the gallery page lightweight
import { lazy } from "react";

const XRWaveViewExperience = lazy(() => import("../components/XRWaveView"));
const BlinkBrowserExperience = lazy(
  () => import("./blink-scroll/BlinkBrowser"),
);
const NeuralSonificationExperience = lazy(
  () => import("./neural-sonification/NeuralSonification"),
);
const VRChatOSCExperience = lazy(
  () => import("./vrchat-osc/VRChatOSC"),
);
const SpoonBendExperience = lazy(
  () => import("./spoon-bend/SpoonBend"),
);
const WebhookWizardExperience = lazy(
  () => import("./webhook-wizard/WebhookWizard"),
);
const EyeTrackExperience = lazy(
  () => import("./eye-track/EyeTrack"),
);
const NorthernLightsExperience = lazy(
  () => import("./northern-lights/NorthernLights"),
);
const MindCastExperience = lazy(
  () => import("./mindcast/MindCast"),
);
const P300MiniGameExperience = lazy(
  () => import("./p300-mini-game/P300MiniGame"),
);
const PremeditatioMalorumExperience = lazy(
  () => import("./premeditatio-malorum/PremeditatioMalorum"),
);
const AvatarFoundationExperience = lazy(
  () => import("./avatar-foundation/AvatarFoundation"),
);
const GlitchingRealityExperience = lazy(
  () => import("./glitching-reality/GlitchingReality"),
);
const FaceTrainerExperience = lazy(
  () => import("./face-trainer/FaceTrainer"),
);

export const EXPERIENCES: ExperienceEntry[] = [
  {
    id: "xr-wave-view",
    name: "Neural Wave Space",
    description:
      "Immersive 3D EEG visualization — waves curve around you in a cosmic starfield. Supports VR headsets with hand tracking.",
    tag: "VR / 3D",
    gradient: ["#7c3aed", "#3b82f6"],
    component: XRWaveViewExperience,
    vr: true,
    handTracking: true,
    author: "PiEEG community",
  },
  {
    id: "blink-browser",
    name: "Blink Browser",
    description:
      "Scroll through articles and web pages using eye blinks. Includes per-user calibration that adapts to your blink strength.",
    tag: "BCI",
    gradient: ["#0070f3", "#00c853"],
    component: BlinkBrowserExperience,
    author: "PiEEG community",
  },
  {
    id: "neural-sonification",
    name: "Neural Sonification",
    description:
      "Turn your brainwaves into live music — Delta drives a deep drone, Theta shapes an FM pad, Alpha opens a melodic lead, Beta adds bright harmonics, and Gamma sparkles with shimmer. Full DJ controls for scale, key, reverb, and delay.",
    tag: "Audio",
    gradient: ["#f59e0b", "#ef4444"],
    component: NeuralSonificationExperience,
    author: "PiEEG community",
  },
  {
    id: "vrchat-osc",
    name: "VRChat OSC Bridge",
    description:
      "Stream live EEG band powers into VRChat via OSC UDP. Show your mental state in the chatbox bubble above your avatar's head, or drive avatar expressions and animations with normalised band-power float parameters.",
    tag: "VRChat",
    gradient: ["#1565c0", "#6a1b9a"],
    component: VRChatOSCExperience,
    author: "PiEEG community",
  },
  {
    id: "spoon-bend",
    name: "Spoon Bend",
    description:
      "Channel your focus to bend a virtual spoon — Matrix style. Beta and Gamma brainwaves drive the bend while digital rain cascades around you. Includes baseline calibration for personalised sensitivity.",
    tag: "Focus",
    gradient: ["#059669", "#0a0a0a"],
    component: SpoonBendExperience,
    author: "PiEEG community",
  },
  {
    id: "webhook-wizard",
    name: "Webhook Wizard",
    description:
      "Guided walkthrough to set up your first brain-powered automation — connect IFTTT, Zapier, or any webhook in 60 seconds with live EEG feedback.",
    tag: "Automation",
    gradient: ["#ff4a00", "#33ccff"],
    component: WebhookWizardExperience,
    author: "PiEEG community",
  },
  {
    id: "eye-track",
    name: "Eye Track",
    description:
      "EOG-based gaze estimation using Fp1/Fp2 frontal electrodes. Polynomial ridge regression (degree 2) maps eye signals to screen position. Online adaptive learning continuously improves accuracy — save your trained model to localStorage and resume later. Includes a live algorithm editor.",
    tag: "BCI",
    gradient: ["#06b6d4", "#8b5cf6"],
    component: EyeTrackExperience,
    author: "PiEEG community",
  },
  {
    id: "northern-lights",
    name: "Northern Lights",
    description:
      "Stand beneath your own aurora borealis — three layered curtains of light dance across an arctic sky, shaped in real-time by your brainwaves. Delta sways the curtains, Alpha brightens the glow, Gamma sparks particles at the edges. Ethereal sonification turns each band into wind, drones, and crystalline chimes. VR headset with hand tracking supported.",
    tag: "VR / Audio",
    gradient: ["#22c55e", "#7c3aed"],
    component: NorthernLightsExperience,
    vr: true,
    handTracking: true,
    author: "PiEEG community",
  },
  {
    id: "mindcast",
    name: "MindCast",
    description:
      "A podcast that listens to your brain — playback speed adapts to your focus in real-time. Zone out and it slows down, lock in and it speeds up. Your attention is the throttle.",
    tag: "Audio",
    gradient: ["#06b6d4", "#22c55e"],
    component: MindCastExperience,
    author: "PiEEG community",
  },
  {
    id: "p300-mini-game",
    name: "P300 Mini-Game",
    description:
      "Brain-controlled selection game powered by a full P300 neural decoding engine — shrinkage-LDA decoder with subject-specific calibration, Bayesian evidence accumulation, cross-session model reuse, confidence scoring, and exportable labelled datasets. Themeable stimulus grid (icons / letters / monsters / spells); architecturally a reusable ML core any mini-game can plug into via the shared marker contract.",
    tag: "BCI / ML",
    gradient: ["#22d3ee", "#7c3aed"],
    component: P300MiniGameExperience,
    author: "PiEEG community",
  },
  {
    id: "avatar-foundation",
    name: "Avatar Neurofeedback Studio",
    description:
      "Drive a VRM avatar's face directly from your EEG. Every electrode and every standard EEG band (δ θ α β γ) is a draggable signal source; every facial expression is a controllable sink. A Figma-style mapping panel lets you compose Links (channel × band → expression) and a two-state contrastive trainer (REST vs ACTIVE) ranks the 32 electrodes × 5 bands by Cohen's d and auto-picks your strongest cue. Live activation bars, per-link gain / smoothing / inversion, persistent calibration. Full neurofeedback avatar manipulation, with the rigor of qEEG.",
    tag: "BCI / Avatar",
    gradient: ["#6366f1", "#22d3ee"],
    component: AvatarFoundationExperience,
    author: "PiEEG community",
  },
  {
    id: "premeditatio-malorum",
    name: "Premeditatio Malorum",
    description:
      "Mixed-reality Stoic training in your Meta Quest Browser. Pairs of 360° YouTube scenes (fire vs. forest, storm vs. lagoon, city vs. summit, cliff vs. meadow) deliver classical Stoic exercises \u2014 Premeditatio Malorum, Amor Fati, Summum Bonum, Memento Mori. Hold high alpha through the disruption; the score is how fast your beta spike decays back to your personal baseline. Includes 30 s eyes-closed calibration, sci-fi HUD telemetry, and a scorecard.",
    tag: "XR / Stoic",
    gradient: ["#5cf2ff", "#b388ff"],
    component: PremeditatioMalorumExperience,
    vr: true,
    author: "PiEEG community",
  },
  {
    id: "glitching-reality",
    name: "The Glitching Reality",
    description:
      "I wired my brain to my room. If I lose focus, reality breaks. A mixed-reality demonstration of Frontal Alpha Asymmetry — your device camera becomes a passthrough layer, a WebGL2 shader composites EEG-driven glitches on top. Equanimity keeps the room pristine; cognitive load shreds it with RGB split, slice tear, harsh light, and noise. A deep breath snaps reality back to clarity. Includes an optional timed mental-arithmetic stressor.",
    tag: "MR / Shader",
    gradient: ["#ff3366", "#5cf2ff"],
    component: GlitchingRealityExperience,
    author: "PiEEG community",
  },
  {
    id: "face-trainer",
    name: "Face Trainer",
    description:
      "Placement-agnostic facial-EMG trainer for 8 electrodes driving an ARKit-rigged 3D face. Record reps per expression (jaw open, smile, brows up/down, hard blink, wink L/R, pucker) and fit a per-expression L2 + group-lasso logistic-regression detector on CAR-referenced time-domain features (5 features × 8 channels). Leave-one-rep-out balanced accuracy gives an honest readiness score; the group-lasso channel bar shows which electrodes actually carry the signal for each expression. Try mode previews the live posterior; Free Mode runs every ready detector in parallel. Complements Avatar Foundation, which does single-expression Cohen's-d contrastive on EEG bands.",
    tag: "BCI / ML / Face",
    gradient: ["#22d3ee", "#22c55e"],
    component: FaceTrainerExperience,
    author: "PiEEG community",
  },
];
