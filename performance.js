const PERF_TIERS = {
    off: { label: "Off", maxPixelRatio: Infinity, maxFps: 0, highPerformanceGpu: false, gc: null },
    balanced: { label: "Balanced", maxPixelRatio: 1.5, maxFps: 0, highPerformanceGpu: true, gc: { pause: 300, stepMul: 100 } },
    low: { label: "Low", maxPixelRatio: 1, maxFps: 30, highPerformanceGpu: true, gc: { pause: 300, stepMul: 100 } },
}

function getPerfTier(version) {
    try {
        const stored = localStorage.getItem("webPerfTier:" + version)
        if (stored in PERF_TIERS) return stored
        if (localStorage.getItem("webPerfMode:" + version) === "1") return "low"
    } catch {}
    return "off"
}

function setPerfTier(version, tier) {
    try {
        localStorage.setItem("webPerfTier:" + version, tier)
    } catch {}
}

function limitFrameRate(maxFps) {
    const interval = 1000 / maxFps
    const nativeRaf = window.requestAnimationFrame.bind(window)
    let lastFrame = 0
    window.requestAnimationFrame = function (callback) {
        return nativeRaf(function schedule(now) {
            if (now - lastFrame < interval - 2) {
                nativeRaf(schedule)
                return
            }
            lastFrame = now
            callback(now)
        })
    }
}

function preferHighPerformanceGpu() {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
            attributes = Object.assign({ powerPreference: "high-performance" }, attributes)
        }
        return nativeGetContext.call(this, type, attributes)
    }
}

function capPixelRatio(max) {
    const real = window.devicePixelRatio || 1
    if (real <= max) return
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => max })
}

function getPerfArguments(version) {
    const gc = PERF_TIERS[getPerfTier(version)].gc
    return gc ? ["--web-gc", String(gc.pause), String(gc.stepMul)] : []
}

function applyPerformance(version) {
    logHitches()
    const tier = PERF_TIERS[getPerfTier(version)]
    if (tier.maxPixelRatio !== Infinity) capPixelRatio(tier.maxPixelRatio)
    if (tier.maxFps) limitFrameRate(tier.maxFps)
    if (tier.highPerformanceGpu) preferHighPerformanceGpu()
}

function logHitches(thresholdMs = 100) {
    if (!window.PerformanceObserver || !PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) return
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            if (entry.duration >= thresholdMs) {
                console.warn("[web-hitch] frame took " + Math.round(entry.duration) + " ms (blocked " + Math.round(entry.blockingDuration) + " ms)")
            }
        }
    }).observe({ type: "long-animation-frame", buffered: false })
}
