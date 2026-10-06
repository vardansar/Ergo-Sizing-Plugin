type Params = { resWidth: number; resHeight: number; screenUnit: "inches" | "mm"; screenWidth: number; screenHeight: number; targetUnit: "inches" | "mm"; targetWidth: number; targetHeight: number; lockAspect: boolean; scaleBy: "width" | "height" }
type Attachment = { version: 1; params: Params; state: unknown | null }
type RunMsg =
  | { type: 'action'; id: string; params: Partial<Params> }
  | { type: 'resize'; height: number }
  | { type: 'screen-locked'; locked: boolean }
const TOOL_ID = "6c03b7d9-6972-406e-9d50-e0baec29f9df"
const DISPLAY_NAME = "Physical size scaler"
const ATTACH_KEY = TOOL_ID + ':state'
const DEFAULTS: Params = { resWidth: 1920, resHeight: 1080, screenUnit: "inches", screenWidth: 27, screenHeight: 15.6, targetUnit: "inches", targetWidth: 2, targetHeight: 1, lockAspect: true, scaleBy: "width" }
let latestParams: Params = DEFAULTS
let isExecuting = false

function finiteNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeParams(input: Partial<Params> | null | undefined): Params {
  const value = input ?? {}
  return {
    resWidth: clamp(finiteNumber(value.resWidth, DEFAULTS.resWidth), 1, 15360),
    resHeight: clamp(finiteNumber(value.resHeight, DEFAULTS.resHeight), 1, 8640),
    screenUnit: ["inches","mm"].includes(String(value.screenUnit)) ? (String(value.screenUnit) as Params['screenUnit']) : DEFAULTS.screenUnit,
    screenWidth: clamp(finiteNumber(value.screenWidth, DEFAULTS.screenWidth), 0.1, 200),
    screenHeight: clamp(finiteNumber(value.screenHeight, DEFAULTS.screenHeight), 0.1, 200),
    targetUnit: ["inches","mm"].includes(String(value.targetUnit)) ? (String(value.targetUnit) as Params['targetUnit']) : DEFAULTS.targetUnit,
    targetWidth: clamp(finiteNumber(value.targetWidth, DEFAULTS.targetWidth), 0, 1000),
    targetHeight: clamp(finiteNumber(value.targetHeight, DEFAULTS.targetHeight), 0, 1000),
    lockAspect: typeof value.lockAspect === 'boolean' ? value.lockAspect : DEFAULTS.lockAspect,
    scaleBy: ["width","height"].includes(String(value.scaleBy)) ? (String(value.scaleBy) as Params['scaleBy']) : DEFAULTS.scaleBy,
  }
}

function htmlEscapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function setBooleanControl(html: string, id: string, value: boolean): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const checked = new RegExp('(<fig-switch[^>]*id="' + escaped + '"[^>]*)\\schecked(=[^\\s>]*)?', 'g')
  let next = html.replace(checked, '$1')
  if (value) {
    const target = new RegExp('(<fig-switch[^>]*id="' + escaped + '"[^>]*)(>)', 'g')
    next = next.replace(target, '$1 checked$2')
  }
  return next
}

function uniqueSceneNodes(nodes: readonly SceneNode[]): SceneNode[] {
  return [...new Set(nodes)].filter((node) => !node.removed)
}

function attachRelaunch(nodes: readonly SceneNode[]): void {
  const unique = uniqueSceneNodes(nodes)
  if (unique.length > 0) {
    for (const node of unique) node.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  } else {
    figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  }
}

function singleSelectedTarget(): SceneNode | null {
  const selection = figma.currentPage.selection
  return selection.length === 1 ? (selection[0] ?? null) : null
}

function readAttachment(node: SceneNode): Attachment | null {
  try {
    const parsed = JSON.parse(node.getPluginData(ATTACH_KEY)) as Partial<Attachment>
    if (parsed?.version !== 1) return null
    return {
      version: 1,
      params: normalizeParams(parsed.params),
      state: (parsed.state ?? null) as unknown | null,
    }
  } catch {
    return null
  }
}

function writeAttachment(node: SceneNode, params: Params, state: unknown | null): void {
  node.setPluginData(ATTACH_KEY, JSON.stringify({ version: 1, params, state }))
}

function status_scale(selection: readonly SceneNode[], enabled: boolean): string {
  if (!enabled) return "Select a layer"
  if (selection.length === 1 && selection[0].type === 'TEXT') return "Text — scales cap height"
  return "Ready to scale"
}
function evaluateEnabled_scale(selection: readonly SceneNode[]): boolean {
  return selection.length === 1
}
function actionTarget_scale(): SceneNode | null {
  const target = singleSelectedTarget()
  if (target == null) return null
  return evaluateEnabled_scale([target]) ? target : null
}
async function measureCapHeightRatio(font: FontName, fontSize: number): Promise<number> {
  const probe = figma.createText()
  await figma.loadFontAsync(font)
  probe.fontName = font
  probe.fontSize = fontSize
  probe.lineHeight = { value: fontSize, unit: 'PIXELS' }
  probe.characters = 'H'
  const capPx = probe.height
  probe.remove()
  return capPx / fontSize
}

async function action_scale(params: Params, target: SceneNode): Promise<{ affectedNodes: SceneNode[]; state: unknown | null }> {
  const affectedNodes: SceneNode[] = [target]
  const screenWInches = params.screenUnit === 'mm'
    ? params.screenWidth / 25.4
    : params.screenWidth
  const screenHInches = params.screenUnit === 'mm'
    ? params.screenHeight / 25.4
    : params.screenHeight
  const ppiX = params.resWidth / screenWInches
  const ppiY = params.resHeight / screenHInches
  const ppiAvg = (ppiX + ppiY) / 2

  const targetHInches = params.targetUnit === 'mm'
    ? params.targetHeight / 25.4
    : params.targetHeight
  const targetWInches = params.targetUnit === 'mm'
    ? params.targetWidth / 25.4
    : params.targetWidth

  // Text layer: scale font size so cap height matches target physical height
  if (target.type === 'TEXT') {
    const textNode = target as TextNode
    const fontName = textNode.fontName
    if (fontName === figma.mixed) {
      figma.notify('Mixed fonts not supported — select text with a single font')
      return { affectedNodes, state: null }
    }
    const currentFontSize = textNode.fontSize
    if (currentFontSize === figma.mixed) {
      figma.notify('Mixed font sizes not supported — select text with a single size')
      return { affectedNodes, state: null }
    }
    await figma.loadFontAsync(fontName)
    const capRatio = await measureCapHeightRatio(fontName, 100)
    if (capRatio <= 0) {
      figma.notify('Could not measure cap height')
      return { affectedNodes, state: null }
    }
    // Desired cap height in px based on target physical height
    const desiredCapHeightPx = targetHInches * ppiY
    // fontSize that produces that cap height: capHeightPx = fontSize * capRatio
    const newFontSize = Math.max(1, Math.round(desiredCapHeightPx / capRatio))
    textNode.fontSize = newFontSize

    const actualCapPx = newFontSize * capRatio
    const unit = params.targetUnit === 'mm' ? 'mm' : 'in'
    const physHeight = params.targetUnit === 'mm'
      ? (actualCapPx / ppiY * 25.4).toFixed(1)
      : (actualCapPx / ppiY).toFixed(2)
    figma.notify(`Cap height → ${physHeight} ${unit} (font size ${newFontSize}px @ ${ppiAvg.toFixed(1)} PPI)`)
    return { affectedNodes, state: null }
  }

  // Non-text layer: resize the frame/shape
  const targetWPx = targetWInches * ppiX
  const targetHPx = targetHInches * ppiY
  const currentW = target.width
  const currentH = target.height
  if (currentW === 0 || currentH === 0) {
    figma.notify('Layer has zero dimensions')
    return { affectedNodes, state: null }
  }
  let newW: number
  let newH: number
  if (params.lockAspect) {
    const aspect = currentW / currentH
    if (params.scaleBy === 'width') {
      newW = targetWPx
      newH = targetWPx / aspect
    } else {
      newH = targetHPx
      newW = targetHPx * aspect
    }
  } else {
    newW = targetWPx
    newH = targetHPx
  }
  newW = Math.max(0.01, newW)
  newH = Math.max(0.01, newH)
  if ('resize' in target) {
    const resizable = target as SceneNode & { resize(w: number, h: number): void }
    resizable.resize(newW, newH)
  }
  const ppi = ppiAvg.toFixed(1)
  const unit = params.targetUnit === 'mm' ? 'mm' : 'in'
  const finalWPhys = params.targetUnit === 'mm'
    ? (newW / ppiX * 25.4).toFixed(1)
    : (newW / ppiX).toFixed(2)
  const finalHPhys = params.targetUnit === 'mm'
    ? (newH / ppiY * 25.4).toFixed(1)
    : (newH / ppiY).toFixed(2)
  figma.notify(`Scaled to ${finalWPhys} × ${finalHPhys} ${unit} @ ${ppi} PPI → ${Math.round(newW)} × ${Math.round(newH)} px`)
  return { affectedNodes, state: null }
}
async function runAction_scale(target: SceneNode, notify: boolean): Promise<void> {
  isExecuting = true
  try {
    const result = await action_scale(latestParams, target)
    writeAttachment(target, latestParams, result.state)
    attachRelaunch(result.affectedNodes)
    pushActionStates()
    if (notify) {
      const created = result.affectedNodes.filter((node) => node !== target)
      if (created.length > 0) {
        figma.viewport.scrollAndZoomIntoView(created)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    figma.notify(message, { error: true })
    throw error
  } finally {
    isExecuting = false
  }
}


function pushActionStates(): void {
  const selection = figma.currentPage.selection
  const t_scale = actionTarget_scale()
  const enabled_scale = t_scale != null
  figma.ui.postMessage({
    type: 'action-state',
    actions: {
      "scale": { enabled: enabled_scale, label: "Scale layer", status: status_scale(selection, enabled_scale) },
    },
  })
}
function refreshSelection(): void {
  if (isExecuting) return
  const target = singleSelectedTarget()
  const attachment = target != null ? readAttachment(target) : null
  if (attachment) {
    latestParams = attachment.params
    figma.ui.postMessage({ type: 'params-change', params: latestParams })
  }
  pushActionStates()
}

const initialTarget = singleSelectedTarget()
const initialAttachment = initialTarget != null ? readAttachment(initialTarget) : null
const initialParams: Params = initialAttachment?.params ?? DEFAULTS
latestParams = initialParams
let html = __html__
html = html.replace(/(id="resWidth"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.resWidth)) + '$2')
html = html.replace(/(id="resHeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.resHeight)) + '$2')
html = html.replace(/(id="screenUnit"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.screenUnit)) + '$2')
html = html.replace(/(id="screenWidth"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.screenWidth)) + '$2')
html = html.replace(/(id="screenHeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.screenHeight)) + '$2')
html = html.replace(/(id="targetUnit"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.targetUnit)) + '$2')
html = html.replace(/(id="targetWidth"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.targetWidth)) + '$2')
html = html.replace(/(id="targetHeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.targetHeight)) + '$2')
html = setBooleanControl(html, "lockAspect", initialParams.lockAspect)
html = html.replace(/(id="scaleBy"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.scaleBy)) + '$2')
figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
figma.showUI(html, { width: 280, height: 320 })
pushActionStates()
figma.on('selectionchange', refreshSelection)

figma.ui.onmessage = (msg: RunMsg) => {
  if (msg.type === 'resize') {
    figma.ui.resize(280, Math.max(120, Math.min(900, Math.round(msg.height))))
    return
  }
  if (msg.type === 'screen-locked') {
    return
  }
  if (msg.type === 'action') {
    if (msg.id === "scale") {
      const target = actionTarget_scale()
      if (target == null) return
      latestParams = normalizeParams(msg.params)
      void runAction_scale(target, true)
      return
    }
    return
  }
}
