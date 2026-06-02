// ============================================
// Infinite Whiteboard - Optimized Rendering
// 3-layer canvas: background + committed + live
// ============================================

// Camera
let camX = 0;
let camY = 0;
let scale = 1;

// Drawing state
let currentTool = 'draw';
let currentColor = '#222222';
let brushSize = 3;
let isDrawing = false;
let lastWorldX = 0;
let lastWorldY = 0;
let isPanning = false;
let panStartScreenX = 0;
let panStartScreenY = 0;
let panStartCamX = 0;
let panStartCamY = 0;
let drawingHistory = [];
let currentStroke = null;

// Element state
let elements = [];
let dragTarget = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let resizeTarget = null;
let resizeStartDist = 0;
let resizeStartScale = 0;
let resizeAnchorWorld = null;
let textColor = '#222222';

// Pinch zoom
let pinchStartDist = 0;
let pinchStartScale = 1;
let lastPinchCenter = null;
let pinchStartCamX = 0;
let pinchStartCamY = 0;

// Render state
let viewportDirty = true;   // need to rebuild committed canvas from history
let compositeDirty = true;  // need to recomposite layers to screen
let animFrameId = null;

// Sticker placement
let stickerPlaceMode = false;
let selectedSticker = null;

// DOM
const boardContainer = document.getElementById('boardContainer');
const canvas = document.getElementById('chalkCanvas');
const ctx = canvas.getContext('2d');
const elementsLayer = document.getElementById('elementsLayer');
const textModal = document.getElementById('textModal');
const textInput = document.getElementById('textInput');
const photoInput = document.getElementById('photoInput');
const brushSizeInput = document.getElementById('brushSize');
const stickerPicker = document.getElementById('stickerPicker');

// Offscreen canvases
const committedCanvas = document.createElement('canvas');
const cctx = committedCanvas.getContext('2d');
const liveCanvas = document.createElement('canvas');
const lctx = liveCanvas.getContext('2d');

// Multi-user sync — same-browser tabs fallback (only used when Firebase is off)
let broadcastChannel = null;
try {
    broadcastChannel = new BroadcastChannel('whiteboard_sync');
    broadcastChannel.onmessage = (e) => {
        if (!firebaseReady && e.data.type === 'state_update') {
            loadStateFromData(e.data.state);
        }
    };
} catch (ex) { /* BroadcastChannel not supported */ }

// ============================================
// Firebase real-time sync (additive, per-item)
//
// Each stroke and element is stored under its own id key, so two
// devices merge into the UNION of their content instead of
// overwriting each other. child_added/changed/removed keep every
// client live without ever clobbering concurrent edits.
// ============================================
let firebaseDb = null;
let firebaseReady = false;
let strokesRef = null;
let elementsRef = null;
const knownStrokeIds = new Set();   // ids already applied locally (ignore our own echoes)
const knownElementIds = new Set();

function setSyncConnected() {
    const statusEl = document.getElementById('syncStatus');
    if (statusEl) {
        statusEl.textContent = 'Synced';
        statusEl.classList.add('connected');
    }
}

function cacheLocal() {
    try { localStorage.setItem('chalkboard_state', JSON.stringify(buildState())); } catch (e) { /* ignore */ }
}

// Firebase rejects undefined/null — build a clean object per element
function serializeElement(item) {
    const out = {};
    ['id', 'type', 'x', 'y', 'color', 'text', 'fontSize', 'src', 'rotation', 'sticker', 'elScale'].forEach(k => {
        if (item[k] !== undefined && item[k] !== null) out[k] = item[k];
    });
    return out;
}

function createElementFromData(el) {
    if (el.type === 'text') addTextElement(el.text, el.x, el.y, el.color, el.fontSize, el.id, el.elScale);
    else if (el.type === 'photo') addPhotoElement(el.src, el.x, el.y, el.rotation, el.id, el.elScale);
    else if (el.type === 'sticker') addStickerElement(el.sticker, el.x, el.y, el.id, el.elScale);
}

function applyRemoteElementUpdate(el) {
    const item = elements.find(x => x.id === el.id);
    const domEl = document.querySelector(`[data-id="${el.id}"]`);
    if (!item || !domEl) {
        if (!item) { createElementFromData(el); knownElementIds.add(el.id); }
        return;
    }
    item.x = el.x;
    item.y = el.y;
    if (el.elScale !== undefined) item.elScale = el.elScale;
    if (el.rotation !== undefined) item.rotation = el.rotation;
    domEl.dataset.worldX = el.x;
    domEl.dataset.worldY = el.y;
    if (el.elScale !== undefined) domEl.dataset.elScale = el.elScale;
    if (el.rotation !== undefined) domEl.dataset.rotation = el.rotation;
}

function initFirebase() {
    if (typeof FIREBASE_CONFIG === 'undefined' || !FIREBASE_CONFIG.databaseURL) {
        console.info('Firebase not configured — local-only mode. Edit firebase-config.js to enable sync.');
        return;
    }
    try {
        firebase.initializeApp(FIREBASE_CONFIG);
        firebaseDb = firebase.database();
        strokesRef = firebaseDb.ref('board/strokes');
        elementsRef = firebaseDb.ref('board/elements');
        firebaseReady = true;
        setSyncConnected();
        console.info('Firebase connected — real-time sync enabled!');

        // One-time reconcile: merge remote <-> local into the union, then go live
        firebaseDb.ref('board').once('value').then((snap) => {
            const data = snap.val() || {};
            const remoteStrokes = data.strokes || {};
            const remoteElements = data.elements || {};

            // Pull remote strokes we don't already have
            Object.values(remoteStrokes).forEach(s => {
                if (s && s.id) {
                    if (!drawingHistory.find(x => x.id === s.id)) drawingHistory.push(s);
                    knownStrokeIds.add(s.id);
                }
            });
            // Pull remote elements we don't already have
            Object.values(remoteElements).forEach(el => {
                if (el && el.id) {
                    if (!elements.find(x => x.id === el.id)) createElementFromData(el);
                    knownElementIds.add(el.id);
                }
            });
            // Push our local-only strokes up
            drawingHistory.forEach(s => {
                if (s.id && !remoteStrokes[s.id]) {
                    knownStrokeIds.add(s.id);
                    strokesRef.child(s.id).set(s).catch(() => {});
                }
            });
            // Push our local-only elements up
            elements.forEach(el => {
                if (el.id && !remoteElements[el.id]) {
                    knownElementIds.add(el.id);
                    elementsRef.child(el.id).set(serializeElement(el)).catch(() => {});
                }
            });

            viewportDirty = true;
            compositeDirty = true;
            cacheLocal();
            attachLiveListeners();
        }).catch(err => {
            console.warn('Firebase reconcile failed:', err);
            attachLiveListeners();
        });
    } catch (e) {
        console.warn('Firebase init failed:', e);
    }
}

function attachLiveListeners() {
    strokesRef.on('child_added', (snap) => {
        const s = snap.val();
        if (!s || !s.id || knownStrokeIds.has(s.id)) return;
        knownStrokeIds.add(s.id);
        if (!drawingHistory.find(x => x.id === s.id)) {
            drawingHistory.push(s);
            viewportDirty = true;
            compositeDirty = true;
            cacheLocal();
        }
    });
    strokesRef.on('child_removed', (snap) => {
        const s = snap.val();
        if (!s || !s.id) return;
        knownStrokeIds.delete(s.id);
        const before = drawingHistory.length;
        drawingHistory = drawingHistory.filter(x => x.id !== s.id);
        if (drawingHistory.length !== before) {
            viewportDirty = true;
            compositeDirty = true;
            cacheLocal();
        }
    });

    elementsRef.on('child_added', (snap) => {
        const el = snap.val();
        if (!el || !el.id || knownElementIds.has(el.id)) return;
        knownElementIds.add(el.id);
        if (!elements.find(x => x.id === el.id)) {
            createElementFromData(el);
            cacheLocal();
        }
    });
    elementsRef.on('child_changed', (snap) => {
        const el = snap.val();
        if (!el || !el.id) return;
        applyRemoteElementUpdate(el);
        cacheLocal();
    });
    elementsRef.on('child_removed', (snap) => {
        const el = snap.val();
        if (!el || !el.id) return;
        knownElementIds.delete(el.id);
        const domEl = document.querySelector(`[data-id="${el.id}"]`);
        if (domEl) domEl.remove();
        elements = elements.filter(x => x.id !== el.id);
        cacheLocal();
    });
}

// ---- Local action -> Firebase (per-item, never clobbers others) ----
function syncPushStroke(stroke) {
    if (!firebaseReady || !stroke || !stroke.id) return;
    knownStrokeIds.add(stroke.id);
    strokesRef.child(stroke.id).set(stroke).catch(() => {});
}
function syncRemoveStroke(id) {
    if (!firebaseReady || !id) return;
    knownStrokeIds.delete(id);
    strokesRef.child(id).remove().catch(() => {});
}
function syncPushElement(item) {
    if (!firebaseReady || !item || !item.id) return;
    knownElementIds.add(item.id);
    elementsRef.child(item.id).set(serializeElement(item)).catch(() => {});
}
function syncUpdateElement(item) {
    if (!firebaseReady || !item || !item.id) return;
    knownElementIds.add(item.id);
    const patch = { x: item.x, y: item.y };
    if (item.elScale !== undefined) patch.elScale = item.elScale;
    if (item.rotation !== undefined) patch.rotation = item.rotation;
    elementsRef.child(item.id).update(patch).catch(() => {});
}
function syncRemoveElement(id) {
    if (!firebaseReady || !id) return;
    knownElementIds.delete(id);
    elementsRef.child(id).remove().catch(() => {});
}
function syncClearBoard() {
    if (!firebaseReady) return;
    knownStrokeIds.clear();
    knownElementIds.clear();
    firebaseDb.ref('board').remove().catch(() => {});
}

// ============================================
// Sticker Data
// ============================================
const STICKER_CATEGORIES = {
    'Birthday': ['🎂', '🎉', '🎈', '🎁', '🎊', '🥳', '🎀', '🕯️', '🍰', '🧁', '🎇', '🎆', '🪅', '🎏', '🎐'],
    'Hearts': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🩷', '🤎', '🖤', '🤍', '💕', '💞', '💓', '💗', '💖'],
    'Faces': ['😊', '😍', '🥰', '😘', '🤩', '😎', '🥹', '😂', '🤗', '😇', '🫶', '🙌', '👏', '✌️', '🤟'],
    'Food': ['🍕', '🍔', '🌮', '🍣', '🍩', '🍪', '🍫', '🧋', '🍿', '🌈', '☕', '🫧', '🍦', '🥤', '🎵'],
    'Nature': ['🌸', '🌺', '🌻', '🌷', '🌹', '🌼', '🍀', '🌿', '🦋', '🐝', '⭐', '🌟', '✨', '💫', '🌙'],
    'Animals': ['🐶', '🐱', '🐰', '🦊', '🐼', '🦄', '🐸', '🐥', '🦩', '🐙', '🐳', '🦈', '🦜', '🦕', '🐨'],
    'Fun': ['🎸', '🎹', '🎨', '🎭', '🏆', '🎯', '🎲', '🛸', '🚀', '💎']
};

// ============================================
// Canvas setup
// ============================================
function resizeCanvas() {
    const rect = boardContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const w = rect.width;
    const h = rect.height;
    const pw = w * dpr;
    const ph = h * dpr;

    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    committedCanvas.width = pw;
    committedCanvas.height = ph;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    liveCanvas.width = pw;
    liveCanvas.height = ph;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    viewportDirty = true;
    compositeDirty = true;
}

function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (sx - rect.left) / scale + camX,
        y: (sy - rect.top) / scale + camY
    };
}

function worldToScreen(wx, wy) {
    return {
        x: (wx - camX) * scale,
        y: (wy - camY) * scale
    };
}

// ============================================
// Background
// ============================================
function drawBackground() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Dot grid
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    const gridSize = 40 * scale;
    if (gridSize > 4) {
        const offX = ((-camX * scale) % gridSize + gridSize) % gridSize;
        const offY = ((-camY * scale) % gridSize + gridSize) % gridSize;
        for (let x = offX; x < w; x += gridSize) {
            for (let y = offY; y < h; y += gridSize) {
                ctx.beginPath();
                ctx.arc(x, y, 0.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

// ============================================
// Marker drawing on a target context
// ============================================
function drawMarkerSegment(target, x1, y1, x2, y2, color, size) {
    const s1 = worldToScreen(x1, y1);
    const s2 = worldToScreen(x2, y2);
    const sz = size * scale;

    target.lineCap = 'round';
    target.lineJoin = 'round';

    // Main stroke
    target.strokeStyle = color;
    target.lineWidth = sz;
    target.globalAlpha = 0.6;
    target.beginPath();
    target.moveTo(s1.x, s1.y);
    target.lineTo(s2.x, s2.y);
    target.stroke();

    // Darker center
    target.lineWidth = sz * 0.4;
    target.globalAlpha = 0.3;
    target.beginPath();
    target.moveTo(s1.x, s1.y);
    target.lineTo(s2.x, s2.y);
    target.stroke();

    target.globalAlpha = 1;
}

function eraseSegment(target, x1, y1, x2, y2, size) {
    const s1 = worldToScreen(x1, y1);
    const s2 = worldToScreen(x2, y2);
    const sz = size * 3 * scale;

    target.globalCompositeOperation = 'destination-out';
    target.lineWidth = sz;
    target.lineCap = 'round';
    target.beginPath();
    target.moveTo(s1.x, s1.y);
    target.lineTo(s2.x, s2.y);
    target.stroke();
    target.globalCompositeOperation = 'source-over';
}

// ============================================
// Visibility culling
// ============================================
function isStrokeVisible(stroke, vl, vt, vr, vb) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const pad = stroke.size * 4;
    return maxX + pad >= vl && minX - pad <= vr && maxY + pad >= vt && minY - pad <= vb;
}

// ============================================
// Rebuild committed canvas from history
// ============================================
function rebuildCommitted() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    cctx.clearRect(0, 0, w, h);

    const vl = camX, vt = camY;
    const vr = camX + w / scale;
    const vb = camY + h / scale;

    for (const stroke of drawingHistory) {
        if (stroke.type !== 'line' || !isStrokeVisible(stroke, vl, vt, vr, vb)) continue;
        for (let i = 1; i < stroke.points.length; i++) {
            const p1 = stroke.points[i - 1];
            const p2 = stroke.points[i];
            if (stroke.eraser) {
                eraseSegment(cctx, p1.x, p1.y, p2.x, p2.y, stroke.size);
            } else {
                drawMarkerSegment(cctx, p1.x, p1.y, p2.x, p2.y, stroke.color, stroke.size);
            }
        }
    }
    viewportDirty = false;
}

// ============================================
// Composite to screen: bg + committed + live
// ============================================
function compositeToScreen() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);
    drawBackground();

    // Draw committed strokes
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(committedCanvas, 0, 0);
    // Draw live stroke on top
    ctx.drawImage(liveCanvas, 0, 0);
    ctx.restore();

    compositeDirty = false;
}

// ============================================
// Render loop
// ============================================
function renderLoop() {
    if (viewportDirty) {
        rebuildCommitted();
        compositeDirty = true;
    }
    if (compositeDirty) {
        compositeToScreen();
    }
    updateElementPositions();
    animFrameId = requestAnimationFrame(renderLoop);
}

// ============================================
// Element positioning
// ============================================
function updateElementPositions() {
    const els = elementsLayer.children;
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const wx = parseFloat(el.dataset.worldX);
        const wy = parseFloat(el.dataset.worldY);
        const s = worldToScreen(wx, wy);
        const rot = parseFloat(el.dataset.rotation) || 0;
        const elScale = parseFloat(el.dataset.elScale) || 1;
        el.style.transform = `translate(${s.x}px, ${s.y}px) scale(${scale * elScale}) rotate(${rot}deg)`;
    }
}

// ============================================
// State persistence
// ============================================
let saveTimeout = null;
function saveState() {
    // Debounce saves to avoid lag during rapid actions
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(_doSave, 300);
}

function _doSave() {
    try {
        const state = buildState();
        localStorage.setItem('chalkboard_state', JSON.stringify(state));
        // Cross-tab fallback only matters when Firebase isn't running the show
        if (broadcastChannel && !firebaseReady) {
            broadcastChannel.postMessage({ type: 'state_update', state });
        }
    } catch (e) {
        console.warn('Could not save state:', e);
    }
}

function buildState() {
    return {
        strokes: drawingHistory,
        elements: elements.map(el => ({
            id: el.id, type: el.type, x: el.x, y: el.y,
            color: el.color, text: el.text, fontSize: el.fontSize,
            src: el.src, rotation: el.rotation, sticker: el.sticker,
            elScale: el.elScale
        })),
        cam: { x: camX, y: camY, scale }
    };
}

function loadState() {
    try {
        const saved = localStorage.getItem('chalkboard_state');
        if (saved) {
            loadStateFromData(JSON.parse(saved));
        }
    } catch (e) {
        console.warn('Could not load state:', e);
    }
}

function loadStateFromData(state) {
    drawingHistory = (state.strokes || []).map(s => s.id ? s : { ...s, id: genId() });
    if (state.cam) {
        camX = state.cam.x;
        camY = state.cam.y;
        scale = state.cam.scale || 1;
    }
    // Clear existing DOM elements
    elementsLayer.innerHTML = '';
    elements = [];
    (state.elements || []).forEach(el => {
        if (el.type === 'text') {
            addTextElement(el.text, el.x, el.y, el.color, el.fontSize, el.id, el.elScale);
        } else if (el.type === 'photo') {
            addPhotoElement(el.src, el.x, el.y, el.rotation, el.id, el.elScale);
        } else if (el.type === 'sticker') {
            addStickerElement(el.sticker, el.x, el.y, el.id, el.elScale);
        }
    });
    viewportDirty = true;
    compositeDirty = true;
}

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ============================================
// Resize handle creation
// ============================================
function createResizeHandle(parentEl) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.addEventListener('mousedown', startResize);
    handle.addEventListener('touchstart', startResizeTouch, { passive: false });
    parentEl.appendChild(handle);
    return handle;
}

function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget.parentElement;
    resizeTarget = el;
    const world = screenToWorld(e.clientX, e.clientY);
    const wx = parseFloat(el.dataset.worldX);
    const wy = parseFloat(el.dataset.worldY);
    resizeAnchorWorld = { x: wx, y: wy };
    resizeStartDist = Math.hypot(world.x - wx, world.y - wy);
    resizeStartScale = parseFloat(el.dataset.elScale) || 1;
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', endResize);
}

function startResizeTouch(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const touch = e.touches[0];
    const el = e.currentTarget.parentElement;
    resizeTarget = el;
    const world = screenToWorld(touch.clientX, touch.clientY);
    const wx = parseFloat(el.dataset.worldX);
    const wy = parseFloat(el.dataset.worldY);
    resizeAnchorWorld = { x: wx, y: wy };
    resizeStartDist = Math.hypot(world.x - wx, world.y - wy);
    resizeStartScale = parseFloat(el.dataset.elScale) || 1;
    document.addEventListener('touchmove', onResizeTouch, { passive: false });
    document.addEventListener('touchend', endResizeTouch);
}

function onResize(e) {
    if (!resizeTarget) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const dist = Math.hypot(world.x - resizeAnchorWorld.x, world.y - resizeAnchorWorld.y);
    const ratio = dist / Math.max(resizeStartDist, 1);
    resizeTarget.dataset.elScale = Math.max(0.2, Math.min(5, resizeStartScale * ratio));
}

function onResizeTouch(e) {
    if (!resizeTarget) return;
    e.preventDefault();
    const touch = e.touches[0];
    const world = screenToWorld(touch.clientX, touch.clientY);
    const dist = Math.hypot(world.x - resizeAnchorWorld.x, world.y - resizeAnchorWorld.y);
    const ratio = dist / Math.max(resizeStartDist, 1);
    resizeTarget.dataset.elScale = Math.max(0.2, Math.min(5, resizeStartScale * ratio));
}

function endResize() {
    if (resizeTarget) {
        updateElementData(resizeTarget);
        resizeTarget = null;
    }
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', endResize);
}

function endResizeTouch() {
    if (resizeTarget) {
        updateElementData(resizeTarget);
        resizeTarget = null;
    }
    document.removeEventListener('touchmove', onResizeTouch);
    document.removeEventListener('touchend', endResizeTouch);
}

// ============================================
// Element creation
// ============================================
function addTextElement(text, wx, wy, color, fontSize, id, elScale) {
    id = id || genId();
    elScale = elScale || 1;
    const el = document.createElement('div');
    el.className = 'board-text';
    el.style.color = color || '#222222';
    el.style.fontSize = (fontSize || 24) + 'px';
    el.textContent = text;
    el.dataset.id = id;
    el.dataset.worldX = wx;
    el.dataset.worldY = wy;
    el.dataset.elScale = elScale;

    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    let item = elements.find(e => e.id === id);
    if (!item) {
        item = { id, type: 'text', x: wx, y: wy, color: color || '#222222', text, fontSize: fontSize || 24, elScale };
        elements.push(item);
    }
    return item;
}

function addPhotoElement(src, wx, wy, rotation, id, elScale) {
    id = id || genId();
    rotation = rotation || (Math.random() * 10 - 5);
    elScale = elScale || 1;
    const el = document.createElement('div');
    el.className = 'board-photo';
    el.dataset.id = id;
    el.dataset.worldX = wx;
    el.dataset.worldY = wy;
    el.dataset.rotation = rotation;
    el.dataset.elScale = elScale;

    const pin = document.createElement('div');
    pin.className = 'pin';

    const img = document.createElement('img');
    img.src = src;
    img.draggable = false;

    el.appendChild(pin);
    el.appendChild(img);
    createResizeHandle(el);

    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    let item = elements.find(e => e.id === id);
    if (!item) {
        item = { id, type: 'photo', x: wx, y: wy, src, rotation, elScale };
        elements.push(item);
    }
    return item;
}

function addStickerElement(emoji, wx, wy, id, elScale) {
    id = id || genId();
    elScale = elScale || 1;
    const el = document.createElement('div');
    el.className = 'board-sticker';
    el.textContent = emoji;
    el.dataset.id = id;
    el.dataset.worldX = wx;
    el.dataset.worldY = wy;
    el.dataset.elScale = elScale;

    createResizeHandle(el);

    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    let item = elements.find(e => e.id === id);
    if (!item) {
        item = { id, type: 'sticker', x: wx, y: wy, sticker: emoji, elScale };
        elements.push(item);
    }
    return item;
}

// ============================================
// Element dragging
// ============================================
function eraseElement(el) {
    const id = el.dataset.id;
    elements = elements.filter(e => e.id !== id);
    el.remove();
    syncRemoveElement(id);
    saveState();
}

function startDragElement(e) {
    if (currentTool === 'eraser') {
        e.preventDefault();
        e.stopPropagation();
        eraseElement(e.currentTarget);
        return;
    }
    if (currentTool === 'draw') return;
    // Don't start drag if resize handle was clicked
    if (e.target.classList.contains('resize-handle')) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    dragTarget = el;
    const world = screenToWorld(e.clientX, e.clientY);
    dragOffsetX = world.x - parseFloat(el.dataset.worldX);
    dragOffsetY = world.y - parseFloat(el.dataset.worldY);
    document.addEventListener('mousemove', onDragElement);
    document.addEventListener('mouseup', endDragElement);
}

function startDragElementTouch(e) {
    if (currentTool === 'eraser') {
        e.preventDefault();
        e.stopPropagation();
        eraseElement(e.currentTarget);
        return;
    }
    if (currentTool === 'draw') return;
    if (e.target.classList.contains('resize-handle')) return;
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const touch = e.touches[0];
    const el = e.currentTarget;
    dragTarget = el;
    const world = screenToWorld(touch.clientX, touch.clientY);
    dragOffsetX = world.x - parseFloat(el.dataset.worldX);
    dragOffsetY = world.y - parseFloat(el.dataset.worldY);
    document.addEventListener('touchmove', onDragElementTouch, { passive: false });
    document.addEventListener('touchend', endDragElementTouch);
}

function onDragElement(e) {
    if (!dragTarget) return;
    const world = screenToWorld(e.clientX, e.clientY);
    dragTarget.dataset.worldX = world.x - dragOffsetX;
    dragTarget.dataset.worldY = world.y - dragOffsetY;
}

function onDragElementTouch(e) {
    if (!dragTarget) return;
    e.preventDefault();
    const touch = e.touches[0];
    const world = screenToWorld(touch.clientX, touch.clientY);
    dragTarget.dataset.worldX = world.x - dragOffsetX;
    dragTarget.dataset.worldY = world.y - dragOffsetY;
}

function endDragElement() {
    if (dragTarget) {
        updateElementData(dragTarget);
        dragTarget = null;
    }
    document.removeEventListener('mousemove', onDragElement);
    document.removeEventListener('mouseup', endDragElement);
}

function endDragElementTouch() {
    if (dragTarget) {
        updateElementData(dragTarget);
        dragTarget = null;
    }
    document.removeEventListener('touchmove', onDragElementTouch);
    document.removeEventListener('touchend', endDragElementTouch);
}

function updateElementData(el) {
    const id = el.dataset.id;
    const item = elements.find(e => e.id === id);
    if (item) {
        item.x = parseFloat(el.dataset.worldX);
        item.y = parseFloat(el.dataset.worldY);
        item.elScale = parseFloat(el.dataset.elScale) || 1;
        const rot = parseFloat(el.dataset.rotation);
        if (!isNaN(rot)) item.rotation = rot;
        syncUpdateElement(item);
    }
    saveState();
}

// ============================================
// Mouse drawing - FAST PATH
// ============================================
canvas.addEventListener('mousedown', (e) => {
    if (stickerPlaceMode && selectedSticker) {
        const world = screenToWorld(e.clientX, e.clientY);
        syncPushElement(addStickerElement(selectedSticker, world.x, world.y));
        saveState();
        return;
    }

    if (currentTool === 'pan') {
        isPanning = true;
        panStartScreenX = e.clientX;
        panStartScreenY = e.clientY;
        panStartCamX = camX;
        panStartCamY = camY;
        canvas.style.cursor = 'grabbing';
        return;
    }
    if (currentTool !== 'draw' && currentTool !== 'eraser') return;
    isDrawing = true;
    const world = screenToWorld(e.clientX, e.clientY);
    lastWorldX = world.x;
    lastWorldY = world.y;
    currentStroke = {
        id: genId(),
        type: 'line',
        color: currentColor,
        size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: world.x, y: world.y }]
    };
});

canvas.addEventListener('mousemove', (e) => {
    if (isPanning) {
        camX = panStartCamX - (e.clientX - panStartScreenX) / scale;
        camY = panStartCamY - (e.clientY - panStartScreenY) / scale;
        viewportDirty = true;
        return;
    }
    if (!isDrawing) return;
    const world = screenToWorld(e.clientX, e.clientY);

    // Draw ONLY the new segment on live canvas (fast!)
    if (currentTool === 'eraser') {
        // Eraser draws directly on committed canvas
        eraseSegment(cctx, lastWorldX, lastWorldY, world.x, world.y, brushSize);
    } else {
        drawMarkerSegment(lctx, lastWorldX, lastWorldY, world.x, world.y, currentColor, brushSize);
    }
    compositeDirty = true; // just recomposite, don't rebuild

    currentStroke.points.push({ x: world.x, y: world.y });
    lastWorldX = world.x;
    lastWorldY = world.y;
});

canvas.addEventListener('mouseup', endDrawing);
canvas.addEventListener('mouseleave', endDrawing);

function endDrawing() {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
        saveState();
        return;
    }
    if (isDrawing && currentStroke && currentStroke.points.length > 1) {
        drawingHistory.push(currentStroke);
        syncPushStroke(currentStroke);

        if (!currentStroke.eraser) {
            // Merge live canvas into committed canvas
            const rect = canvas.getBoundingClientRect();
            cctx.save();
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.drawImage(liveCanvas, 0, 0);
            cctx.restore();
        }
        // Clear live canvas
        const rect = canvas.getBoundingClientRect();
        lctx.clearRect(0, 0, rect.width, rect.height);
        compositeDirty = true;

        saveState();
    }
    isDrawing = false;
    currentStroke = null;
}

// ============================================
// Touch events
// ============================================
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        isDrawing = false;
        if (currentStroke) {
            lctx.clearRect(0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
            currentStroke = null;
        }
        const t1 = e.touches[0], t2 = e.touches[1];
        pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        pinchStartScale = scale;
        pinchStartCamX = camX;
        pinchStartCamY = camY;
        lastPinchCenter = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };
        return;
    }

    if (stickerPlaceMode && selectedSticker) {
        e.preventDefault();
        const world = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
        syncPushElement(addStickerElement(selectedSticker, world.x, world.y));
        saveState();
        return;
    }

    if (currentTool === 'pan') {
        e.preventDefault();
        isPanning = true;
        panStartScreenX = e.touches[0].clientX;
        panStartScreenY = e.touches[0].clientY;
        panStartCamX = camX;
        panStartCamY = camY;
        return;
    }

    if (currentTool !== 'draw' && currentTool !== 'eraser') return;
    e.preventDefault();
    const world = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    lastWorldX = world.x;
    lastWorldY = world.y;
    isDrawing = true;
    currentStroke = {
        id: genId(),
        type: 'line', color: currentColor, size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: world.x, y: world.y }]
    };
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const newScale = Math.max(0.1, Math.min(5, pinchStartScale * (dist / pinchStartDist)));
        const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        const rect = canvas.getBoundingClientRect();
        const cx = center.x - rect.left;
        const cy = center.y - rect.top;
        const worldX = pinchStartCamX + cx / pinchStartScale;
        const worldY = pinchStartCamY + cy / pinchStartScale;
        const panDx = (center.x - lastPinchCenter.x) / newScale;
        const panDy = (center.y - lastPinchCenter.y) / newScale;
        camX = worldX - cx / newScale - panDx;
        camY = worldY - cy / newScale - panDy;
        scale = newScale;
        lastPinchCenter = center;
        viewportDirty = true;
        return;
    }

    if (isPanning) {
        e.preventDefault();
        camX = panStartCamX - (e.touches[0].clientX - panStartScreenX) / scale;
        camY = panStartCamY - (e.touches[0].clientY - panStartScreenY) / scale;
        viewportDirty = true;
        return;
    }

    if (!isDrawing) return;
    e.preventDefault();
    const world = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    if (currentTool === 'eraser') {
        eraseSegment(cctx, lastWorldX, lastWorldY, world.x, world.y, brushSize);
    } else {
        drawMarkerSegment(lctx, lastWorldX, lastWorldY, world.x, world.y, currentColor, brushSize);
    }
    compositeDirty = true;
    currentStroke.points.push({ x: world.x, y: world.y });
    lastWorldX = world.x;
    lastWorldY = world.y;
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) lastPinchCenter = null;
    if (isPanning) {
        isPanning = false;
        saveState();
        return;
    }
    endDrawing();
});

// Click to add text
canvas.addEventListener('click', (e) => {
    if (currentTool !== 'text') return;
    const world = screenToWorld(e.clientX, e.clientY);
    showTextModal(world.x, world.y);
});

// ============================================
// Text modal
// ============================================
function showTextModal(wx, wy) {
    textModal.classList.add('active');
    textInput.value = '';
    textInput.focus();
    textColor = currentColor;

    const modalColors = document.getElementById('modalColors');
    modalColors.innerHTML = '';
    ['#222222', '#e74c3c', '#2980b9', '#27ae60', '#8e44ad', '#e67e22', '#e91e8c', '#16a085'].forEach(c => {
        const btn = document.createElement('button');
        btn.className = 'color-btn' + (c === textColor ? ' active' : '');
        btn.style.background = c;
        btn.addEventListener('click', () => {
            modalColors.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            textColor = c;
        });
        modalColors.appendChild(btn);
    });

    document.getElementById('textConfirm').onclick = () => {
        const text = textInput.value.trim();
        if (text) {
            syncPushElement(addTextElement(text, wx, wy, textColor, 24));
            saveState();
        }
        textModal.classList.remove('active');
    };
    document.getElementById('textCancel').onclick = () => {
        textModal.classList.remove('active');
    };
}

// ============================================
// Sticker picker
// ============================================
function initStickerPicker() {
    const tabsContainer = document.getElementById('stickerTabs');
    const grid = document.getElementById('stickerGrid');
    const searchInput = document.getElementById('stickerSearch');
    const categories = Object.keys(STICKER_CATEGORIES);

    const allTab = document.createElement('button');
    allTab.className = 'sticker-tab active';
    allTab.textContent = 'All';
    allTab.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
        allTab.classList.add('active');
        searchInput.value = '';
        renderStickers(null);
    });
    tabsContainer.appendChild(allTab);

    categories.forEach(cat => {
        const tab = document.createElement('button');
        tab.className = 'sticker-tab';
        tab.textContent = cat;
        tab.addEventListener('click', () => {
            tabsContainer.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            searchInput.value = '';
            renderStickers(cat);
        });
        tabsContainer.appendChild(tab);
    });

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase();
        tabsContainer.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
        renderFilteredStickers(query);
    });

    renderStickers(null);
}

function renderStickers(category) {
    const grid = document.getElementById('stickerGrid');
    grid.innerHTML = '';
    const stickers = category ? (STICKER_CATEGORIES[category] || []) : Object.values(STICKER_CATEGORIES).flat();
    stickers.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'sticker-option';
        btn.textContent = emoji;
        btn.addEventListener('click', () => selectSticker(emoji));
        grid.appendChild(btn);
    });
}

function renderFilteredStickers(query) {
    const grid = document.getElementById('stickerGrid');
    grid.innerHTML = '';
    const all = [];
    for (const [cat, stickers] of Object.entries(STICKER_CATEGORIES)) {
        if (!query || cat.toLowerCase().includes(query)) {
            stickers.forEach(s => { if (!all.includes(s)) all.push(s); });
        }
    }
    if (all.length === 0) {
        Object.values(STICKER_CATEGORIES).flat().forEach(s => { if (!all.includes(s)) all.push(s); });
    }
    all.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'sticker-option';
        btn.textContent = emoji;
        btn.addEventListener('click', () => selectSticker(emoji));
        grid.appendChild(btn);
    });
}

function selectSticker(emoji) {
    selectedSticker = emoji;
    stickerPlaceMode = true;
    stickerPicker.classList.remove('active');
    canvas.style.cursor = 'copy';
}

function toggleStickerPicker() {
    if (stickerPicker.classList.contains('active')) {
        stickerPicker.classList.remove('active');
        stickerPlaceMode = false;
        selectedSticker = null;
    } else {
        stickerPicker.classList.add('active');
    }
}

// ============================================
// Photo upload
// ============================================
photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const cw = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
        syncPushElement(addPhotoElement(ev.target.result, cw.x - 100, cw.y - 100, null));
        saveState();
    };
    reader.readAsDataURL(file);
    photoInput.value = '';
});

// ============================================
// Tool buttons
// ============================================
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.tool !== 'sticker') {
            stickerPicker.classList.remove('active');
            stickerPlaceMode = false;
            selectedSticker = null;
        }

        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;

        if (currentTool === 'sticker') {
            toggleStickerPicker();
            return;
        }

        if (currentTool === 'photo') {
            photoInput.click();
            setTimeout(() => {
                document.querySelector('[data-tool="draw"]').classList.add('active');
                btn.classList.remove('active');
                currentTool = 'draw';
            }, 100);
        }

        canvas.style.cursor =
            currentTool === 'pan' ? 'grab' :
            currentTool === 'eraser' ? 'cell' :
            currentTool === 'text' ? 'text' : 'crosshair';
    });
});

document.querySelectorAll('#colorPalette .color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#colorPalette .color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
    });
});

brushSizeInput.addEventListener('input', (e) => {
    brushSize = parseInt(e.target.value);
});

// ============================================
// Zoom controls
// ============================================
function zoomAtCenter(newScale) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const wcx = camX + cx / scale, wcy = camY + cy / scale;
    scale = newScale;
    camX = wcx - cx / scale;
    camY = wcy - cy / scale;
    viewportDirty = true;
}

document.getElementById('zoomIn').addEventListener('click', () => zoomAtCenter(Math.min(5, scale * 1.25)));
document.getElementById('zoomOut').addEventListener('click', () => zoomAtCenter(Math.max(0.1, scale / 1.25)));

document.getElementById('undoBtn').addEventListener('click', () => {
    if (drawingHistory.length > 0) {
        const removed = drawingHistory.pop();
        if (removed) syncRemoveStroke(removed.id);
        viewportDirty = true;
        saveState();
    }
});

document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear the entire board? This cannot be undone!')) {
        drawingHistory = [];
        elements = [];
        elementsLayer.innerHTML = '';
        viewportDirty = true;
        syncClearBoard();
        saveState();
    }
});

boardContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const wx = camX + cx / scale, wy = camY + cy / scale;
    scale = Math.max(0.1, Math.min(5, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
    camX = wx - cx / scale;
    camY = wy - cy / scale;
    viewportDirty = true;
}, { passive: false });

// ============================================
// Keyboard shortcuts
// ============================================
let spaceWasDown = false;
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        document.getElementById('undoBtn').click();
    }
    if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        spaceWasDown = true;
        document.querySelector('[data-tool="pan"]').click();
    }
    if (e.key === 'Escape') {
        stickerPicker.classList.remove('active');
        stickerPlaceMode = false;
        selectedSticker = null;
        canvas.style.cursor = 'crosshair';
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spaceWasDown) {
        spaceWasDown = false;
        document.querySelector('[data-tool="draw"]').click();
    }
});

// Home button
document.getElementById('homeBtn').addEventListener('click', () => {
    const rect = canvas.getBoundingClientRect();
    camX = -rect.width / 2;
    camY = -rect.height / 2;
    scale = 1;
    viewportDirty = true;
});

// ============================================
// Init
// ============================================
resizeCanvas();
loadState();
initStickerPicker();
initFirebase();
if (!localStorage.getItem('chalkboard_state')) {
    const rect = canvas.getBoundingClientRect();
    camX = -rect.width / 2;
    camY = -rect.height / 2;
}
renderLoop();

window.addEventListener('resize', () => {
    resizeCanvas();
});

if ('ontouchstart' in window) {
    const hint = document.createElement('div');
    hint.className = 'zoom-hint';
    hint.textContent = 'Pinch to zoom \u2022 Two fingers to pan \u2022 Endless whiteboard!';
    document.body.appendChild(hint);
    setTimeout(() => hint.classList.add('visible'), 1000);
    setTimeout(() => hint.classList.remove('visible'), 5000);
}
