// ============================================
// Infinite Chalkboard - World Coordinate System
// ============================================

// Camera / viewport (world coords of the top-left of the screen)
let camX = 0;
let camY = 0;
let scale = 1;

// State
let currentTool = 'draw';
let currentColor = '#FFFFFF';
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
let elements = []; // text and photo elements
let dragTarget = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let textColor = '#FFFFFF';
let pinchStartDist = 0;
let pinchStartScale = 1;
let lastPinchCenter = null;
let pinchStartCamX = 0;
let pinchStartCamY = 0;
let needsRedraw = true;
let animFrameId = null;

// DOM
const boardContainer = document.getElementById('boardContainer');
const canvas = document.getElementById('chalkCanvas');
const ctx = canvas.getContext('2d');
const elementsLayer = document.getElementById('elementsLayer');

// Offscreen canvas for strokes (so eraser works correctly)
const strokeCanvas = document.createElement('canvas');
const sctx = strokeCanvas.getContext('2d');
const textModal = document.getElementById('textModal');
const textInput = document.getElementById('textInput');
const photoInput = document.getElementById('photoInput');
const brushSizeInput = document.getElementById('brushSize');

// Resize canvas to fill container
function resizeCanvas() {
    const rect = boardContainer.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    // Match offscreen canvas size
    strokeCanvas.width = canvas.width;
    strokeCanvas.height = canvas.height;
    sctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    needsRedraw = true;
}

// Convert screen coords to world coords
function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    return {
        x: cx / scale + camX,
        y: cy / scale + camY
    };
}

// Convert world coords to screen-relative coords (for CSS positioning)
function worldToScreen(wx, wy) {
    return {
        x: (wx - camX) * scale,
        y: (wy - camY) * scale
    };
}

// Draw chalkboard background grid pattern (subtle)
function drawBackground() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Fill with board green
    ctx.fillStyle = '#2a3a2a';
    ctx.fillRect(0, 0, w, h);

    // Subtle gradient overlays
    const g1 = ctx.createRadialGradient(w * 0.3, h * 0.3, 0, w * 0.3, h * 0.3, w * 0.6);
    g1.addColorStop(0, 'rgba(60, 80, 60, 0.3)');
    g1.addColorStop(1, 'transparent');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    const g2 = ctx.createRadialGradient(w * 0.7, h * 0.7, 0, w * 0.7, h * 0.7, w * 0.5);
    g2.addColorStop(0, 'rgba(40, 60, 40, 0.2)');
    g2.addColorStop(1, 'transparent');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);

    // Subtle dot grid to give sense of space/movement
    ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
    const gridSize = 50 * scale;
    if (gridSize > 5) { // Only show when not too zoomed out
        const startX = -(camX * scale % gridSize);
        const startY = -(camY * scale % gridSize);
        for (let x = startX; x < w; x += gridSize) {
            for (let y = startY; y < h; y += gridSize) {
                ctx.beginPath();
                ctx.arc(x, y, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

// Draw a chalk line on a given context, in world coords transformed to screen
function drawChalkLineOn(target, x1, y1, x2, y2, color, size) {
    const s1 = worldToScreen(x1, y1);
    const s2 = worldToScreen(x2, y2);
    const scaledSize = size * scale;

    target.strokeStyle = color;
    target.lineWidth = scaledSize;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.globalAlpha = 0.85;
    target.beginPath();
    target.moveTo(s1.x, s1.y);
    target.lineTo(s2.x, s2.y);
    target.stroke();

    // chalk dust effect
    const dist = Math.sqrt((s2.x - s1.x) ** 2 + (s2.y - s1.y) ** 2);
    const dots = Math.floor(dist / 3);
    target.globalAlpha = 0.3;
    target.fillStyle = color;
    for (let i = 0; i < dots; i++) {
        const t = Math.random();
        const px = s1.x + (s2.x - s1.x) * t + (Math.random() - 0.5) * scaledSize * 1.5;
        const py = s1.y + (s2.y - s1.y) * t + (Math.random() - 0.5) * scaledSize * 1.5;
        target.fillRect(px, py, Math.random() * 1.5 + 0.5, Math.random() * 1.5 + 0.5);
    }
    target.globalAlpha = 1;
}

// Erase on a given context, in world coords
function eraseLineOn(target, x1, y1, x2, y2, size) {
    const s1 = worldToScreen(x1, y1);
    const s2 = worldToScreen(x2, y2);
    const scaledSize = size * 3 * scale;

    target.globalCompositeOperation = 'destination-out';
    target.lineWidth = scaledSize;
    target.lineCap = 'round';
    target.beginPath();
    target.moveTo(s1.x, s1.y);
    target.lineTo(s2.x, s2.y);
    target.stroke();
    target.globalCompositeOperation = 'source-over';
}

// Check if a stroke's bounding box is visible
function isStrokeVisible(stroke, viewLeft, viewTop, viewRight, viewBottom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const pad = stroke.size * 2;
    return maxX + pad >= viewLeft && minX - pad <= viewRight &&
           maxY + pad >= viewTop && minY - pad <= viewBottom;
}

// Full redraw
function redrawCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Draw background on main canvas
    ctx.clearRect(0, 0, w, h);
    drawBackground();

    // Draw all strokes on offscreen canvas (so eraser works via destination-out)
    sctx.clearRect(0, 0, w, h);

    // Visible world bounds
    const viewLeft = camX;
    const viewTop = camY;
    const viewRight = camX + w / scale;
    const viewBottom = camY + h / scale;

    drawingHistory.forEach(stroke => {
        if (stroke.type === 'line' && isStrokeVisible(stroke, viewLeft, viewTop, viewRight, viewBottom)) {
            for (let i = 1; i < stroke.points.length; i++) {
                const p1 = stroke.points[i - 1];
                const p2 = stroke.points[i];
                if (stroke.eraser) {
                    eraseLineOn(sctx, p1.x, p1.y, p2.x, p2.y, stroke.size);
                } else {
                    drawChalkLineOn(sctx, p1.x, p1.y, p2.x, p2.y, stroke.color, stroke.size);
                }
            }
        }
    });

    // Composite strokes onto main canvas
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(strokeCanvas, 0, 0);
    ctx.restore();

    needsRedraw = false;
}

// Animation loop for smooth rendering
function renderLoop() {
    if (needsRedraw) {
        redrawCanvas();
    }
    updateElementPositions();
    animFrameId = requestAnimationFrame(renderLoop);
}

// Update DOM element positions based on camera
function updateElementPositions() {
    const els = elementsLayer.children;
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const wx = parseFloat(el.dataset.worldX);
        const wy = parseFloat(el.dataset.worldY);
        const s = worldToScreen(wx, wy);
        const rot = el.dataset.rotation || 0;
        el.style.transform = `translate(${s.x}px, ${s.y}px) scale(${scale}) rotate(${rot}deg)`;
    }
}

// Save state to localStorage
function saveState() {
    try {
        const state = {
            strokes: drawingHistory,
            elements: elements.map(el => ({
                id: el.id,
                type: el.type,
                x: el.x,
                y: el.y,
                color: el.color,
                text: el.text,
                fontSize: el.fontSize,
                src: el.src,
                rotation: el.rotation
            })),
            cam: { x: camX, y: camY, scale }
        };
        localStorage.setItem('chalkboard_state', JSON.stringify(state));
    } catch (e) {
        console.warn('Could not save state:', e);
    }
}

// Load state
function loadState() {
    try {
        const saved = localStorage.getItem('chalkboard_state');
        if (saved) {
            const state = JSON.parse(saved);
            drawingHistory = state.strokes || [];
            if (state.cam) {
                camX = state.cam.x;
                camY = state.cam.y;
                scale = state.cam.scale || 1;
            }
            (state.elements || []).forEach(el => {
                if (el.type === 'text') {
                    addTextElement(el.text, el.x, el.y, el.color, el.fontSize, el.id);
                } else if (el.type === 'photo') {
                    addPhotoElement(el.src, el.x, el.y, el.rotation, el.id);
                }
            });
            needsRedraw = true;
        }
    } catch (e) {
        console.warn('Could not load state:', e);
    }
}

// Generate unique ID
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Add text element to board (world coords)
function addTextElement(text, wx, wy, color, fontSize, id) {
    id = id || genId();
    const el = document.createElement('div');
    el.className = 'board-text';
    el.style.color = color || '#FFFFFF';
    el.style.fontSize = (fontSize || 24) + 'px';
    el.textContent = text;
    el.dataset.id = id;
    el.dataset.worldX = wx;
    el.dataset.worldY = wy;

    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    if (!elements.find(e => e.id === id)) {
        elements.push({ id, type: 'text', x: wx, y: wy, color: color || '#FFFFFF', text, fontSize: fontSize || 24 });
    }
}

// Add photo element to board (world coords)
function addPhotoElement(src, wx, wy, rotation, id) {
    id = id || genId();
    rotation = rotation || (Math.random() * 10 - 5);
    const el = document.createElement('div');
    el.className = 'board-photo';
    el.dataset.id = id;
    el.dataset.worldX = wx;
    el.dataset.worldY = wy;
    el.dataset.rotation = rotation;

    const pin = document.createElement('div');
    pin.className = 'pin';

    const img = document.createElement('img');
    img.src = src;
    img.draggable = false;

    el.appendChild(pin);
    el.appendChild(img);

    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    if (!elements.find(e => e.id === id)) {
        elements.push({ id, type: 'photo', x: wx, y: wy, src, rotation });
    }
}

// Drag elements (in world coords)
function startDragElement(e) {
    if (currentTool === 'draw' || currentTool === 'eraser') return;
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
    if (currentTool === 'draw' || currentTool === 'eraser') return;
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
    const newX = world.x - dragOffsetX;
    const newY = world.y - dragOffsetY;
    dragTarget.dataset.worldX = newX;
    dragTarget.dataset.worldY = newY;
}

function onDragElementTouch(e) {
    if (!dragTarget) return;
    e.preventDefault();
    const touch = e.touches[0];
    const world = screenToWorld(touch.clientX, touch.clientY);
    const newX = world.x - dragOffsetX;
    const newY = world.y - dragOffsetY;
    dragTarget.dataset.worldX = newX;
    dragTarget.dataset.worldY = newY;
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
    }
    saveState();
}

// ============================================
// Mouse events on canvas
// ============================================
canvas.addEventListener('mousedown', (e) => {
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
        type: 'line',
        color: currentColor,
        size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: world.x, y: world.y }]
    };
});

canvas.addEventListener('mousemove', (e) => {
    if (isPanning) {
        const dx = (e.clientX - panStartScreenX) / scale;
        const dy = (e.clientY - panStartScreenY) / scale;
        camX = panStartCamX - dx;
        camY = panStartCamY - dy;
        needsRedraw = true;
        return;
    }
    if (!isDrawing) return;
    const world = screenToWorld(e.clientX, e.clientY);

    if (currentTool === 'eraser') {
        eraseLineOn(sctx, lastWorldX, lastWorldY, world.x, world.y, brushSize);
    } else {
        drawChalkLineOn(sctx, lastWorldX, lastWorldY, world.x, world.y, currentColor, brushSize);
    }
    // Composite live stroke onto main canvas
    needsRedraw = true;
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
        currentStroke = null;
        const t1 = e.touches[0];
        const t2 = e.touches[1];
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
        type: 'line',
        color: currentColor,
        size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: world.x, y: world.y }]
    };
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const newScale = Math.max(0.1, Math.min(5, pinchStartScale * (dist / pinchStartDist)));

        const center = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };

        // Zoom toward pinch center
        const rect = canvas.getBoundingClientRect();
        const cx = center.x - rect.left;
        const cy = center.y - rect.top;

        // World point under the pinch center at the old scale
        const worldX = pinchStartCamX + cx / pinchStartScale;
        const worldY = pinchStartCamY + cy / pinchStartScale;

        // Pan from pinch movement
        const panDx = (center.x - lastPinchCenter.x) / newScale;
        const panDy = (center.y - lastPinchCenter.y) / newScale;

        // New camera so the same world point stays under the pinch center
        camX = worldX - cx / newScale - panDx;
        camY = worldY - cy / newScale - panDy;
        scale = newScale;

        lastPinchCenter = center;
        needsRedraw = true;
        return;
    }

    if (isPanning) {
        e.preventDefault();
        const dx = (e.touches[0].clientX - panStartScreenX) / scale;
        const dy = (e.touches[0].clientY - panStartScreenY) / scale;
        camX = panStartCamX - dx;
        camY = panStartCamY - dy;
        needsRedraw = true;
        return;
    }

    if (!isDrawing) return;
    e.preventDefault();
    const world = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    if (currentTool === 'eraser') {
        eraseLineOn(sctx, lastWorldX, lastWorldY, world.x, world.y, brushSize);
    } else {
        drawChalkLineOn(sctx, lastWorldX, lastWorldY, world.x, world.y, currentColor, brushSize);
    }
    needsRedraw = true;
    currentStroke.points.push({ x: world.x, y: world.y });
    lastWorldX = world.x;
    lastWorldY = world.y;
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        lastPinchCenter = null;
    }
    if (isPanning) {
        isPanning = false;
        saveState();
        return;
    }
    endDrawing();
});

// Click on canvas to add text
canvas.addEventListener('click', (e) => {
    if (currentTool !== 'text') return;
    const world = screenToWorld(e.clientX, e.clientY);
    showTextModal(world.x, world.y);
});

// Text modal
function showTextModal(wx, wy) {
    textModal.classList.add('active');
    textInput.value = '';
    textInput.focus();
    textColor = currentColor;

    const modalColors = document.getElementById('modalColors');
    modalColors.innerHTML = '';
    const colors = ['#FFFFFF', '#FFD700', '#FF6B9D', '#87CEEB', '#98FB98', '#FFB347', '#DDA0DD', '#F0E68C'];
    colors.forEach(c => {
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
            addTextElement(text, wx, wy, textColor, 24);
            saveState();
        }
        textModal.classList.remove('active');
    };

    document.getElementById('textCancel').onclick = () => {
        textModal.classList.remove('active');
    };
}

// Photo upload
photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        // Place at center of current view
        const rect = canvas.getBoundingClientRect();
        const centerWorld = screenToWorld(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
        );
        addPhotoElement(ev.target.result, centerWorld.x - 100, centerWorld.y - 100, null);
        saveState();
    };
    reader.readAsDataURL(file);
    photoInput.value = '';
});

// Tool buttons
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;

        if (currentTool === 'photo') {
            photoInput.click();
            setTimeout(() => {
                document.querySelector('[data-tool="draw"]').classList.add('active');
                btn.classList.remove('active');
                currentTool = 'draw';
            }, 100);
        }

        if (currentTool === 'pan') {
            canvas.style.cursor = 'grab';
        } else if (currentTool === 'eraser') {
            canvas.style.cursor = 'cell';
        } else if (currentTool === 'text') {
            canvas.style.cursor = 'text';
        } else {
            canvas.style.cursor = 'crosshair';
        }
    });
});

// Color buttons
document.querySelectorAll('#colorPalette .color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#colorPalette .color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
    });
});

// Brush size
brushSizeInput.addEventListener('input', (e) => {
    brushSize = parseInt(e.target.value);
});

// Zoom toward center of screen
function zoomAtCenter(newScale) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    // World point at center
    const worldCX = camX + cx / scale;
    const worldCY = camY + cy / scale;

    scale = newScale;

    // Keep same world point at center
    camX = worldCX - cx / scale;
    camY = worldCY - cy / scale;
    needsRedraw = true;
}

document.getElementById('zoomIn').addEventListener('click', () => {
    zoomAtCenter(Math.min(5, scale * 1.25));
});

document.getElementById('zoomOut').addEventListener('click', () => {
    zoomAtCenter(Math.max(0.1, scale / 1.25));
});

// Undo
document.getElementById('undoBtn').addEventListener('click', () => {
    if (drawingHistory.length > 0) {
        drawingHistory.pop();
        needsRedraw = true;
        saveState();
    }
});

// Clear
document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear the entire board? This cannot be undone!')) {
        drawingHistory = [];
        elements = [];
        elementsLayer.innerHTML = '';
        needsRedraw = true;
        saveState();
    }
});

// Mouse wheel zoom (zoom toward cursor)
boardContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const worldX = camX + cx / scale;
    const worldY = camY + cy / scale;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.1, Math.min(5, scale * factor));

    camX = worldX - cx / scale;
    camY = worldY - cy / scale;
    needsRedraw = true;
}, { passive: false });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        document.getElementById('undoBtn').click();
    }
    // Space to temporarily pan
    if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        document.querySelector('[data-tool="pan"]').click();
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
        document.querySelector('[data-tool="draw"]').click();
    }
});

// Home button - reset view to origin
document.getElementById('homeBtn').addEventListener('click', () => {
    camX = -canvas.getBoundingClientRect().width / 2 / scale;
    camY = -canvas.getBoundingClientRect().height / 2 / scale;
    scale = 1;
    needsRedraw = true;
});

// Init
resizeCanvas();
loadState();
// Center camera at origin on first load
if (!localStorage.getItem('chalkboard_state')) {
    const rect = canvas.getBoundingClientRect();
    camX = -rect.width / 2;
    camY = -rect.height / 2;
}
renderLoop();

window.addEventListener('resize', () => {
    resizeCanvas();
    needsRedraw = true;
});

// Show zoom hint on mobile
if ('ontouchstart' in window) {
    const hint = document.createElement('div');
    hint.className = 'zoom-hint';
    hint.textContent = 'Pinch to zoom \u2022 Two fingers to pan \u2022 Endless canvas!';
    document.body.appendChild(hint);
    setTimeout(() => hint.classList.add('visible'), 1000);
    setTimeout(() => hint.classList.remove('visible'), 5000);
}
