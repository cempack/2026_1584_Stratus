function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

export function sourceInfoText(health) {
    if (!health) return "Vols OpenSky · meteo Open-Meteo";

    const mode = health.auth_mode === "oauth" ? "API client OpenSky" : "mode anonyme OpenSky";
    const scope = health.coverage_scope === "global" ? " · globe complet" : "";
    const fallback = health.using_anonymous_fallback ? " · repli anonyme actif" : "";
    const interval = health.poll_interval_seconds
        ? ` · sync ~${Math.round(health.poll_interval_seconds)} s`
        : "";

    if (health.state === "rate_limited") {
        return `OpenSky limite temporairement le flux mondial · reprise dans ${Math.max(1, Math.round(health.retry_in || 0))} s${scope}`;
    }
    if (health.state === "degraded") {
        return health.last_success_age != null
            ? `Dernier lot valide il y a ${Math.round(health.last_success_age)} s · reprise en attente${scope}`
            : `Connexion OpenSky en reprise${scope}`;
    }
    if (health.last_success_age != null) {
        return `${mode}${fallback}${scope}${interval} · rafraichi il y a ${Math.round(health.last_success_age)} s`;
    }
    if (health.cache_loaded_from_disk) {
        return `${mode}${fallback}${scope}${interval} · cache disque restaure`;
    }
    return `Vols OpenSky · meteo Open-Meteo${scope}`;
}

export function deriveLoadState(health) {
    if (!health) {
        return {
            hidden: false,
            label: "Initialisation du flux mondial OpenSky",
            percentText: "0%",
            fillPercent: 0,
            note: "",
            complete: false,
            sweeping: false,
        };
    }

    if (health.last_success || health.cache_loaded_from_disk) {
        return {
            hidden: true,
            label: "Flux mondial OpenSky actif",
            percentText: "OK",
            fillPercent: 100,
            note: "",
            complete: true,
            sweeping: false,
        };
    }

    const percent = clampPercent(health.session_validation_percent ?? 0);
    return {
        hidden: false,
        label: health.scan_label || "Initialisation du flux mondial OpenSky",
        percentText: `${percent}%`,
        fillPercent: percent,
        note: health.configured_api_key
            ? "Connexion au snapshot mondial OpenSky en cours."
            : "Mode anonyme actif tant qu'aucune API key n'est configuree dans le venv.",
        complete: false,
        sweeping: false,
    };
}

export function deriveConnectionStatus(health) {
    if (!health) return { mode: "conn", label: "Chargement" };
    if (health.state === "rate_limited") {
        return { mode: "conn", label: "Limite" };
    }
    if (health.state === "degraded") {
        return { mode: "err", label: "Degrade" };
    }
    if (health.auth_mode === "anonymous") {
        return { mode: "conn", label: "Anonyme" };
    }
    return { mode: "live", label: "En direct" };
}
