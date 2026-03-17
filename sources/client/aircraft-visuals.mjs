export const DEFAULT_PICK_RADIUS = 26;

const HEAVY_CATEGORIES = new Set(["A4", "A5", "A6", "4", "5", "6"]);
const LIGHT_CATEGORIES = new Set(["A1", "A7", "B1", "B2", "B6", "2", "8", "9", "12"]);
const REGIONAL_CATEGORIES = new Set(["A2", "3"]);

const LIGHT_TYPE_PREFIXES = [
    "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9",
    "PA", "P2", "P3", "P4", "BE", "SR", "DA", "TBM", "PC12", "PC6",
    "R44", "R66", "EC20", "EC12", "B06", "M20", "AT", "DHC2",
];
const HEAVY_TYPE_PREFIXES = [
    "A33", "A34", "A35", "A38", "B74", "B77", "B78", "B76", "MD11", "A306", "A310",
];
const REGIONAL_TYPE_PREFIXES = [
    "AT4", "AT7", "DH8", "CRJ", "E17", "E18", "F50", "F70", "F90", "SB3",
];

const LIGHT_DESCRIPTION_RE = /(CESSNA|PIPER|DIAMOND|CIRRUS|BEECH|PILATUS PC-12|TBM|ROBINSON|BELL 4|SKYHAWK|SKYLANE|BONANZA|KING AIR)/i;
const HEAVY_DESCRIPTION_RE = /(AIRBUS A-330|AIRBUS A-340|AIRBUS A-350|AIRBUS A-380|BOEING 747|BOEING 767|BOEING 777|BOEING 787|MD-11|TRISTAR)/i;
const REGIONAL_DESCRIPTION_RE = /(ATR|DASH ?8|Q400|SAAB 340|EMBRAER 1[457]|CRJ|FOKKER 50|TURBOPROP)/i;

const RENDER_METRICS = {
    light: {
        minScaleFactor: 1.24,
        hitMultiplier: 3.7,
        minHitScale: 2.5,
        pickRadius: 34,
    },
    regional: {
        minScaleFactor: 1.0,
        hitMultiplier: 3.0,
        minHitScale: 2.0,
        pickRadius: 28,
    },
    jet: {
        minScaleFactor: 1.0,
        hitMultiplier: 2.8,
        minHitScale: 1.9,
        pickRadius: DEFAULT_PICK_RADIUS,
    },
    heavy: {
        minScaleFactor: 1.04,
        hitMultiplier: 2.8,
        minHitScale: 2.0,
        pickRadius: DEFAULT_PICK_RADIUS,
    },
};

function normalized(value) {
    return (value || "").toString().trim().toUpperCase();
}

function matchesPrefix(value, prefixes) {
    return prefixes.some((prefix) => value.startsWith(prefix));
}

function looksLikeHeavy(type, category, description, speed, altitude) {
    return (
        HEAVY_CATEGORIES.has(category) ||
        matchesPrefix(type, HEAVY_TYPE_PREFIXES) ||
        HEAVY_DESCRIPTION_RE.test(description) ||
        speed > 500 ||
        altitude > 11_800
    );
}

function looksLikeLight(type, category, description, speed, altitude, onGround) {
    if (LIGHT_CATEGORIES.has(category)) return true;
    if (matchesPrefix(type, LIGHT_TYPE_PREFIXES)) return true;
    if (LIGHT_DESCRIPTION_RE.test(description)) return true;
    if (onGround && speed < 90) return true;
    return speed < 155 && altitude < 4_800;
}

function looksLikeRegional(type, category, description, speed, altitude) {
    if (REGIONAL_CATEGORIES.has(category)) return true;
    if (matchesPrefix(type, REGIONAL_TYPE_PREFIXES)) return true;
    if (REGIONAL_DESCRIPTION_RE.test(description)) return true;
    return speed < 300 && altitude < 9_500;
}

export function classifyAircraftVariant(plane) {
    const speed = Number(plane?.gs) || 0;
    const altitude = Number(plane?.alt) || 0;
    const category = normalized(plane?.aircraft_category);
    const type = normalized(plane?.aircraft_type);
    const description = (plane?.aircraft_description || "").toString();
    const onGround = Boolean(plane?.on_ground);

    if (HEAVY_CATEGORIES.has(category) || looksLikeHeavy(type, category, description, speed, altitude)) {
        return "heavy";
    }
    if (looksLikeLight(type, category, description, speed, altitude, onGround)) {
        return "light";
    }
    if (looksLikeRegional(type, category, description, speed, altitude)) {
        return "regional";
    }
    return "jet";
}

export function computeVariantRenderMetrics({ variantId, baseScale, variantScale, scaleBoost = 1 }) {
    const metrics = RENDER_METRICS[variantId] || RENDER_METRICS.jet;
    const rawScale = baseScale * variantScale * scaleBoost;
    const renderScale = Math.max(rawScale, baseScale * metrics.minScaleFactor);
    return {
        renderScale,
        hitScale: Math.max(renderScale * metrics.hitMultiplier, metrics.minHitScale),
        pickRadius: metrics.pickRadius,
    };
}

export function computeRenderSamplingStep(totalPlanes, maxRenderedPlanes) {
    const total = Math.max(0, Number(totalPlanes) || 0);
    const budget = Math.max(1, Number(maxRenderedPlanes) || 1);
    if (total <= budget) return 1;
    return Math.ceil(total / budget);
}

export function computeRenderSamplingOffset(totalPlanes, samplingStep, frameTick) {
    const total = Math.max(0, Number(totalPlanes) || 0);
    const step = Math.max(1, Number(samplingStep) || 1);
    const tick = Math.max(0, Math.floor(Number(frameTick) || 0));
    if (total <= 0 || step <= 1) return 0;
    return tick % Math.min(step, total);
}
