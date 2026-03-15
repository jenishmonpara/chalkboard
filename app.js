// State
let currentTool = 'draw';
let currentColor = '#FFFFFF';
let brushSize = 3;
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
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

// DOM
const board = document.getElementById('board');
const canvas = document.getElementById('chalkCanvas');
const ctx = canvas.getContext('2d');
const elementsLayer = document.getElementById('elementsLayer');
const boardContainer = document.getElementById('boardContainer');
const textModal = document.getElementById('textModal');
const textInput = document.getElementById('textInput');
const photoInput = document.getElementById('photoInput');
const brushSizeInput = document.getElementById('brushSize');

// Init canvas
function initCanvas() {
    canvas.width = 1200;
    canvas.height = 800;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    redrawCanvas();
}

// Apply board transform
function updateTransform() {
    board.style.transform = `scale(${scale})`;
    board.style.transformOrigin = '0 0';
    // Center the board in container
    const containerRect = boardContainer.getBoundingClientRect();
    const boardWidth = 1200 * scale;
    const boardHeight = 800 * scale;
    const frameExtra = scale > 0.5 ? 16 : 10;

    const frame = board.parentElement;
    frame.style.transform = `translate(${panX}px, ${panY}px)`;
}

// Chalk texture drawing
function drawChalkLine(x1, y1, x2, y2, color, size) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // chalk dust effect
    const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const dots = Math.floor(dist / 2);
    ctx.globalAlpha = 0.3;
    for (let i = 0; i < dots; i++) {
        const t = Math.random();
        const px = x1 + (x2 - x1) * t + (Math.random() - 0.5) * size * 1.5;
        const py = y1 + (y2 - y1) * t + (Math.random() - 0.5) * size * 1.5;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, Math.random() * 1.5 + 0.5, Math.random() * 1.5 + 0.5);
    }
    ctx.globalAlpha = 1;
}

// Eraser
function eraseLine(x1, y1, x2, y2, size) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = size * 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
}

// Convert page coords to canvas coords
function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
}

function getTouchCoords(touch) {
    const rect = canvas.getBoundingClientRect();
    const x = (touch.clientX - rect.left) * (canvas.width / rect.width);
    const y = (touch.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
}

// Redraw everything from history
function redrawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawingHistory.forEach(stroke => {
        if (stroke.type === 'line') {
            for (let i = 1; i < stroke.points.length; i++) {
                const p1 = stroke.points[i - 1];
                const p2 = stroke.points[i];
                if (stroke.eraser) {
                    eraseLine(p1.x, p1.y, p2.x, p2.y, stroke.size);
                } else {
                    drawChalkLine(p1.x, p1.y, p2.x, p2.y, stroke.color, stroke.size);
                }
            }
        }
    });
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
            }))
        };
        localStorage.setItem('chalkboard_state', JSON.stringify(state));
    } catch (e) {
        // localStorage might be full for large images
        console.warn('Could not save state:', e);
    }
}

// Load state from localStorage
function loadState() {
    try {
        const saved = localStorage.getItem('chalkboard_state');
        if (saved) {
            const state = JSON.parse(saved);
            drawingHistory = state.strokes || [];
            redrawCanvas();
            (state.elements || []).forEach(el => {
                if (el.type === 'text') {
                    addTextElement(el.text, el.x, el.y, el.color, el.fontSize, el.id);
                } else if (el.type === 'photo') {
                    addPhotoElement(el.src, el.x, el.y, el.rotation, el.id);
                }
            });
        }
    } catch (e) {
        console.warn('Could not load state:', e);
    }
}

// Generate unique ID
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Add text element to board
function addTextElement(text, x, y, color, fontSize, id) {
    id = id || genId();
    const el = document.createElement('div');
    el.className = 'board-text';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.color = color || '#FFFFFF';
    el.style.fontSize = (fontSize || 24) + 'px';
    el.textContent = text;
    el.dataset.id = id;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.remove();
        elements = elements.filter(e => e.id !== id);
        saveState();
    });
    el.appendChild(deleteBtn);

    // Dragging
    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    // Track
    if (!elements.find(e => e.id === id)) {
        elements.push({ id, type: 'text', x, y, color: color || '#FFFFFF', text, fontSize: fontSize || 24 });
    }
}

// Add photo element to board
function addPhotoElement(src, x, y, rotation, id) {
    id = id || genId();
    rotation = rotation || (Math.random() * 10 - 5);
    const el = document.createElement('div');
    el.className = 'board-photo';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--rotation', rotation + 'deg');
    el.dataset.id = id;

    const pin = document.createElement('div');
    pin.className = 'pin';

    const img = document.createElement('img');
    img.src = src;
    img.draggable = false;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.remove();
        elements = elements.filter(e => e.id !== id);
        saveState();
    });

    el.appendChild(pin);
    el.appendChild(img);
    el.appendChild(deleteBtn);

    // Dragging
    el.addEventListener('mousedown', startDragElement);
    el.addEventListener('touchstart', startDragElementTouch, { passive: false });

    elementsLayer.appendChild(el);

    if (!elements.find(e => e.id === id)) {
        elements.push({ id, type: 'photo', x, y, src, rotation });
    }
}

// Drag elements
function startDragElement(e) {
    if (currentTool === 'draw' || currentTool === 'eraser') return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    dragTarget = el;
    const rect = el.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

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
    const rect = el.getBoundingClientRect();
    dragOffsetX = touch.clientX - rect.left;
    dragOffsetY = touch.clientY - rect.top;

    document.addEventListener('touchmove', onDragElementTouch, { passive: false });
    document.addEventListener('touchend', endDragElementTouch);
}

function onDragElement(e) {
    if (!dragTarget) return;
    const boardRect = board.getBoundingClientRect();
    const newX = (e.clientX - boardRect.left - dragOffsetX) * (1200 / boardRect.width);
    const newY = (e.clientY - boardRect.top - dragOffsetY) * (800 / boardRect.height);
    dragTarget.style.left = Math.max(0, Math.min(1100, newX)) + 'px';
    dragTarget.style.top = Math.max(0, Math.min(700, newY)) + 'px';
}

function onDragElementTouch(e) {
    if (!dragTarget) return;
    e.preventDefault();
    const touch = e.touches[0];
    const boardRect = board.getBoundingClientRect();
    const newX = (touch.clientX - boardRect.left - dragOffsetX) * (1200 / boardRect.width);
    const newY = (touch.clientY - boardRect.top - dragOffsetY) * (800 / boardRect.height);
    dragTarget.style.left = Math.max(0, Math.min(1100, newX)) + 'px';
    dragTarget.style.top = Math.max(0, Math.min(700, newY)) + 'px';
}

function endDragElement() {
    if (dragTarget) {
        updateElementPosition(dragTarget);
        dragTarget = null;
    }
    document.removeEventListener('mousemove', onDragElement);
    document.removeEventListener('mouseup', endDragElement);
}

function endDragElementTouch() {
    if (dragTarget) {
        updateElementPosition(dragTarget);
        dragTarget = null;
    }
    document.removeEventListener('touchmove', onDragElementTouch);
    document.removeEventListener('touchend', endDragElementTouch);
}

function updateElementPosition(el) {
    const id = el.dataset.id;
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    const item = elements.find(e => e.id === id);
    if (item) {
        item.x = x;
        item.y = y;
    }
    saveState();
}

// Mouse drawing events
canvas.addEventListener('mousedown', (e) => {
    if (currentTool === 'pan') {
        isPanning = true;
        panStartX = e.clientX - panX;
        panStartY = e.clientY - panY;
        canvas.style.cursor = 'grabbing';
        return;
    }
    if (currentTool !== 'draw' && currentTool !== 'eraser') return;
    isDrawing = true;
    const coords = getCanvasCoords(e);
    lastX = coords.x;
    lastY = coords.y;
    currentStroke = {
        type: 'line',
        color: currentColor,
        size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: lastX, y: lastY }]
    };
});

canvas.addEventListener('mousemove', (e) => {
    if (isPanning) {
        panX = e.clientX - panStartX;
        panY = e.clientY - panStartY;
        updateTransform();
        return;
    }
    if (!isDrawing) return;
    const coords = getCanvasCoords(e);
    if (currentTool === 'eraser') {
        eraseLine(lastX, lastY, coords.x, coords.y, brushSize);
    } else {
        drawChalkLine(lastX, lastY, coords.x, coords.y, currentColor, brushSize);
    }
    currentStroke.points.push({ x: coords.x, y: coords.y });
    lastX = coords.x;
    lastY = coords.y;
});

canvas.addEventListener('mouseup', endDrawing);
canvas.addEventListener('mouseleave', endDrawing);

function endDrawing() {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
        return;
    }
    if (isDrawing && currentStroke && currentStroke.points.length > 1) {
        drawingHistory.push(currentStroke);
        saveState();
    }
    isDrawing = false;
    currentStroke = null;
}

// Touch drawing events
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        // Pinch zoom
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        pinchStartScale = scale;
        lastPinchCenter = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };
        isDrawing = false;
        return;
    }

    if (currentTool === 'pan') {
        e.preventDefault();
        isPanning = true;
        panStartX = e.touches[0].clientX - panX;
        panStartY = e.touches[0].clientY - panY;
        return;
    }

    if (currentTool !== 'draw' && currentTool !== 'eraser') return;
    e.preventDefault();
    const coords = getTouchCoords(e.touches[0]);
    lastX = coords.x;
    lastY = coords.y;
    isDrawing = true;
    currentStroke = {
        type: 'line',
        color: currentColor,
        size: brushSize,
        eraser: currentTool === 'eraser',
        points: [{ x: lastX, y: lastY }]
    };
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const newScale = Math.max(0.3, Math.min(3, pinchStartScale * (dist / pinchStartDist)));
        scale = newScale;

        const center = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };
        if (lastPinchCenter) {
            panX += center.x - lastPinchCenter.x;
            panY += center.y - lastPinchCenter.y;
        }
        lastPinchCenter = center;
        updateTransform();
        return;
    }

    if (isPanning) {
        e.preventDefault();
        panX = e.touches[0].clientX - panStartX;
        panY = e.touches[0].clientY - panStartY;
        updateTransform();
        return;
    }

    if (!isDrawing) return;
    e.preventDefault();
    const coords = getTouchCoords(e.touches[0]);
    if (currentTool === 'eraser') {
        eraseLine(lastX, lastY, coords.x, coords.y, brushSize);
    } else {
        drawChalkLine(lastX, lastY, coords.x, coords.y, currentColor, brushSize);
    }
    currentStroke.points.push({ x: coords.x, y: coords.y });
    lastX = coords.x;
    lastY = coords.y;
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        lastPinchCenter = null;
    }
    if (isPanning) {
        isPanning = false;
        return;
    }
    endDrawing();
});

// Click on board to add text
board.addEventListener('click', (e) => {
    if (currentTool !== 'text') return;
    if (e.target.closest('.board-text') || e.target.closest('.board-photo')) return;
    const rect = board.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (1200 / rect.width);
    const y = (e.clientY - rect.top) * (800 / rect.height);
    showTextModal(x, y);
});

// Text modal
function showTextModal(x, y) {
    textModal.classList.add('active');
    textInput.value = '';
    textInput.focus();
    textColor = currentColor;

    // Populate modal color buttons
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
            addTextElement(text, x, y, textColor, 24);
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
        // Place photo at a random-ish center position
        const x = 100 + Math.random() * 800;
        const y = 100 + Math.random() * 500;
        addPhotoElement(ev.target.result, x, y, null);
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
            // Reset to draw after
            setTimeout(() => {
                document.querySelector('[data-tool="draw"]').classList.add('active');
                btn.classList.remove('active');
                currentTool = 'draw';
            }, 100);
        }

        // Update cursor
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

// Zoom controls
document.getElementById('zoomIn').addEventListener('click', () => {
    scale = Math.min(3, scale + 0.2);
    updateTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
    scale = Math.max(0.3, scale - 0.2);
    updateTransform();
});

// Undo
document.getElementById('undoBtn').addEventListener('click', () => {
    if (drawingHistory.length > 0) {
        drawingHistory.pop();
        redrawCanvas();
        saveState();
    }
});

// Clear
document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear the entire board? This cannot be undone!')) {
        drawingHistory = [];
        elements = [];
        elementsLayer.innerHTML = '';
        redrawCanvas();
        saveState();
    }
});

// Mouse wheel zoom
boardContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    scale = Math.max(0.3, Math.min(3, scale + delta));
    updateTransform();
}, { passive: false });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        document.getElementById('undoBtn').click();
    }
});

// Initial fit to screen
function fitBoard() {
    const container = boardContainer.getBoundingClientRect();
    const scaleX = (container.width - 32) / (1200 + 16);
    const scaleY = (container.height - 32) / (800 + 16);
    scale = Math.min(scaleX, scaleY, 1);
    panX = 0;
    panY = 0;
    updateTransform();
}

// Init
initCanvas();
loadState();
fitBoard();
window.addEventListener('resize', fitBoard);

// Show zoom hint on mobile
if ('ontouchstart' in window) {
    const hint = document.createElement('div');
    hint.className = 'zoom-hint';
    hint.textContent = 'Pinch to zoom • Two fingers to pan';
    document.body.appendChild(hint);
    setTimeout(() => hint.classList.add('visible'), 1000);
    setTimeout(() => hint.classList.remove('visible'), 5000);
}
