import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import {HandType} from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandType"
import TrackedHand from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import {BaseButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"
import {BoundingBoxVisualizer} from "./Spatialization/Scripts/BoundingBoxVisualizer"
import {Detection} from "./Spatialization/Scripts/DetectionHelpers"
import {MLSpatializer} from "./Spatialization/Scripts/MLSpatializer"
import {PinholeCapture} from "./Spatialization/Scripts/PinholeCapture"

const HANDS: HandType[] = ["left", "right"]

const PENDING_COLOR = new vec4(0.1, 0.1, 0.1, 0.7)
const DONE_COLOR = new vec4(0.15, 0.65, 0.25, 0.7)
const CANCELLED_COLOR = new vec4(0.85, 0.15, 0.15, 0.7)
const MARGIN_X = 1.5
const MARGIN_Y = 0.5
const CORNER_RADIUS = 0.5

// Seconds a result message ("checked" / "cancelled") stays on screen
const RESULT_SECONDS = 1.5
// Pinch strength below which the hand counts as open for the cancel gesture
const OPEN_PINCH_STRENGTH = 0.3

/** Duck-typed hooks exposed by GroceryListController.js */
interface ChecklistHooks {
  findUncheckedByName(name: string): {id: number; name: string} | null
  autoCheck(id: number): boolean
}

type SeenItem = {bbox: number[]; time: number}
type Pending = {label: string; id: number; name: string; startTime: number}

/**
 * Checks a grocery item off when the user's hand touches its detection box.
 *
 * Detection boxes have no real depth, so "touching" means a fingertip or the palm
 * projects inside the item's 2D box in the camera image while the hand is at arm's
 * length. A touch starts a countdown; holding an open palm toward the glasses cancels it.
 */
@component
export class AutoCheckOff extends BaseScriptComponent {
  @input
  @hint("MLSpatializer that emits detection updates")
  mlSpatializer: MLSpatializer

  @input
  @hint("PinholeCapture used to project hand joints into the camera image")
  pinholeCapture: PinholeCapture

  @input
  @hint("BoundingBoxVisualizer, used for its detection-to-camera UV mapping")
  boxVisualizer: BoundingBoxVisualizer

  @input
  @hint("The GroceryListController script component")
  checklist: ScriptComponent

  @input
  @hint("Text that shows the countdown and result")
  promptText: Text

  @input
  @allowUndefined
  @hint("Toggleable UIKit button that turns the feature on and off")
  toggle: BaseButton

  @input
  @hint("Whether auto check-off is on when the lens starts")
  enabledAtStart: boolean = true

  @input
  @hint("Seconds the user has to cancel before the item is checked off")
  @widget(new SliderWidget(1, 10, 0.5))
  bufferSeconds: number = 5

  @input
  @hint("Seconds the hand must stay on the item before the countdown starts")
  @widget(new SliderWidget(0, 2, 0.05))
  touchHoldSeconds: number = 0.3

  @input
  @hint("Seconds an item stays touchable after it was last detected (the hand can hide it)")
  @widget(new SliderWidget(0, 2, 0.05))
  detectionMemorySeconds: number = 0.5

  @input
  @hint("Closest a hand joint can be to the camera (cm) and still count as touching")
  minReach: number = 15

  @input
  @hint("Farthest a hand joint can be from the camera (cm) and still count as touching")
  maxReach: number = 75

  @input
  @hint("Extra margin around each detection box, in camera UV units")
  @widget(new SliderWidget(0, 0.2, 0.01))
  boxPadding: number = 0.05

  @input
  @hint("Seconds an open palm must face the glasses to cancel")
  @widget(new SliderWidget(0.1, 2, 0.05))
  palmHoldSeconds: number = 0.5

  @input
  @hint("Minimum wrist-to-middle-fingertip distance (cm) for the hand to count as open")
  openHandLength: number = 12

  @input
  @hint("Seconds before a cancelled item can trigger again")
  cooldownSeconds: number = 10

  @input
  @hint("Log touches and countdown changes")
  debugLogging: boolean = false

  private featureOn: boolean = true
  private seen = new Map<string, SeenItem>()
  private cooldownUntil = new Map<string, number>()
  private touchLabel: string = null
  private touchStart: number = 0
  private palmStart: number = -1
  private pending: Pending = null
  private resultUntil: number = 0
  private hands: TrackedHand[] = []

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
  }

  public isFeatureOn(): boolean {
    return this.featureOn
  }

  public setFeatureOn(on: boolean): void {
    if (this.featureOn === on) {
      return
    }
    this.featureOn = on
    this.log(on ? "enabled" : "disabled")
    if (!on) {
      this.pending = null
      this.touchLabel = null
      this.resultUntil = 0
      this.hidePrompt()
    }
  }

  private onStart(): void {
    if (!this.mlSpatializer || !this.pinholeCapture || !this.boxVisualizer || !this.checklist) {
      print("[AutoCheckOff] mlSpatializer, pinholeCapture, boxVisualizer and checklist inputs must all be set")
      return
    }

    this.hands = HANDS.map((type) => SIK.HandInputData.getHand(type))
    this.mlSpatializer.getDetectionsUpdatedEvent().add((detections: Detection[]) => this.onDetections(detections))

    this.stylePrompt()
    this.hidePrompt()

    this.featureOn = this.enabledAtStart
    if (this.toggle) {
      this.toggle.onValueChange.add((value: number) => this.setFeatureOn(value === 1))
      this.toggle.isOn = this.enabledAtStart
    }
  }

  private onDetections(detections: Detection[]): void {
    const now = getTime()
    const updated = new Set<string>()
    detections.forEach((detection) => {
      const label = detection.label.trim().toLowerCase()
      // Detections come in score order, so keep the best box per label
      if (!updated.has(label)) {
        updated.add(label)
        this.seen.set(label, {bbox: detection.bbox, time: now})
      }
    })
  }

  private onUpdate(): void {
    if (!this.hands.length) {
      return
    }
    const now = getTime()

    if (this.resultUntil > 0 && now >= this.resultUntil) {
      this.resultUntil = 0
      this.hidePrompt()
    }

    if (!this.featureOn) {
      return
    }

    if (this.pending) {
      this.updatePending(now)
    } else if (this.resultUntil === 0) {
      this.updateTouch(now)
    }
  }

  // ---- touch detection -----------------------------------------------------

  private updateTouch(now: number): void {
    const label = this.findTouchedLabel(now)
    if (!label) {
      this.touchLabel = null
      return
    }
    if (label !== this.touchLabel) {
      this.touchLabel = label
      this.touchStart = now
      return
    }
    if (now - this.touchStart < this.touchHoldSeconds) {
      return
    }

    this.touchLabel = null
    const item = this.hooks().findUncheckedByName(label)
    if (!item) {
      return
    }
    this.pending = {label: label, id: item.id, name: item.name, startTime: now}
    this.palmStart = -1
    this.log(`touched ${item.name}, checking off in ${this.bufferSeconds}s`)
  }

  /** The label of a checklist-relevant detection a hand is touching, or null */
  private findTouchedLabel(now: number): string {
    if (this.seen.size === 0 || !this.pinholeCapture.isReady()) {
      return null
    }

    const points = this.handPoints()
    if (points.length === 0) {
      return null
    }

    const cameraPos = this.pinholeCapture.worldSpaceOfTrackingCamera()
    const worldToCapture = this.pinholeCapture.worldToCaptureTransform()
    const cameraModel = this.pinholeCapture.getCameraModel()
    if (!cameraModel) {
      return null
    }

    const uvs: vec2[] = []
    points.forEach((point) => {
      const distance = point.distance(cameraPos)
      if (distance < this.minReach || distance > this.maxReach) {
        return
      }
      const capturePos = worldToCapture.multiplyPoint(point)
      // Capture space looks down -z, so anything else is behind the camera
      if (capturePos.z >= 0) {
        return
      }
      uvs.push(cameraModel.projectToUV(capturePos))
    })
    if (uvs.length === 0) {
      return null
    }

    let touched: string = null
    this.seen.forEach((item, label) => {
      if (touched || now - item.time > this.detectionMemorySeconds) {
        return
      }
      const until = this.cooldownUntil.get(label)
      if (until !== undefined && now < until) {
        return
      }
      if (uvs.some((uv) => this.insideBox(uv, item.bbox))) {
        touched = label
      }
    })
    return touched
  }

  private insideBox(uv: vec2, bbox: number[]): boolean {
    const halfW = bbox[2] / 2
    const halfH = bbox[3] / 2
    // Detection v points down, so the bbox top maps to the larger capture v
    const a = this.boxVisualizer.cropUVToCaptureUV(bbox[0] - halfW, bbox[1] - halfH)
    const b = this.boxVisualizer.cropUVToCaptureUV(bbox[0] + halfW, bbox[1] + halfH)
    const pad = this.boxPadding
    return (
      uv.x >= Math.min(a.x, b.x) - pad &&
      uv.x <= Math.max(a.x, b.x) + pad &&
      uv.y >= Math.min(a.y, b.y) - pad &&
      uv.y <= Math.max(a.y, b.y) + pad
    )
  }

  private handPoints(): vec3[] {
    const points: vec3[] = []
    this.hands.forEach((hand) => {
      if (!hand.isTracked()) {
        return
      }
      ;[hand.indexTip, hand.thumbTip, hand.middleTip].forEach((keypoint) => {
        if (keypoint) {
          points.push(keypoint.position)
        }
      })
      const palm = hand.getPalmCenter()
      if (palm) {
        points.push(palm)
      }
    })
    return points
  }

  // ---- countdown and cancel ------------------------------------------------

  private updatePending(now: number): void {
    const pending = this.pending

    if (this.isPalmRaised()) {
      if (this.palmStart < 0) {
        this.palmStart = now
      } else if (now - this.palmStart >= this.palmHoldSeconds) {
        this.cancelPending(now)
        return
      }
    } else {
      this.palmStart = -1
    }

    const remaining = this.bufferSeconds - (now - pending.startTime)
    if (remaining > 0) {
      const seconds = Math.ceil(remaining)
      this.showPrompt(`Checking off ${pending.name} in ${seconds}…\n✋ Show open palm to cancel`, PENDING_COLOR)
      return
    }

    this.pending = null
    const checked = this.hooks().autoCheck(pending.id)
    if (checked) {
      this.showResult(`✓ ${pending.name} checked off`, DONE_COLOR, now)
      this.log(`checked off ${pending.name}`)
    } else {
      // Checked by pinch, or removed from the list, while counting down
      this.hidePrompt()
    }
  }

  private cancelPending(now: number): void {
    const pending = this.pending
    this.pending = null
    this.palmStart = -1
    this.cooldownUntil.set(pending.label, now + this.cooldownSeconds)
    this.showResult(`Cancelled: ${pending.name} not checked off`, CANCELLED_COLOR, now)
    this.log(`cancelled ${pending.name}`)
  }

  /** Open hand with the palm toward the glasses (a "stop" sign) */
  private isPalmRaised(): boolean {
    return this.hands.some((hand) => {
      if (!hand.isTracked() || !hand.isFacingCamera()) {
        return false
      }
      const strength = hand.getPinchStrength()
      if (strength === null || strength > OPEN_PINCH_STRENGTH) {
        return false
      }
      if (!hand.wrist || !hand.middleTip) {
        return false
      }
      return hand.wrist.position.distance(hand.middleTip.position) >= this.openHandLength
    })
  }

  // ---- prompt --------------------------------------------------------------

  private stylePrompt(): void {
    if (!this.promptText) {
      return
    }
    const background = this.promptText.backgroundSettings
    background.enabled = true
    background.cornerRadius = CORNER_RADIUS
    background.margins = Rect.create(MARGIN_X, MARGIN_X, MARGIN_Y, MARGIN_Y)
  }

  private showPrompt(message: string, color: vec4): void {
    if (!this.promptText) {
      return
    }
    this.promptText.text = message
    this.promptText.backgroundSettings.fill.color = color
    this.promptText.getSceneObject().enabled = true
  }

  private showResult(message: string, color: vec4, now: number): void {
    this.showPrompt(message, color)
    this.resultUntil = now + RESULT_SECONDS
  }

  private hidePrompt(): void {
    if (this.promptText) {
      this.promptText.getSceneObject().enabled = false
    }
  }

  private hooks(): ChecklistHooks {
    return this.checklist as unknown as ChecklistHooks
  }

  private log(message: string): void {
    if (this.debugLogging) {
      print("[AutoCheckOff] " + message)
    }
  }
}
