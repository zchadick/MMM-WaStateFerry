Module.register("MMM-WaStateFerry", {
    defaults: {
        departingTerminalID: 3, // Bainbridge Island
        arrivingTerminalID: 7,  // Seattle
        apiKey: "",
        maxSailings: 5,
        updateInterval: 5 * 60 * 1000,
        animationSpeed: 1000,
        fade: true,
        fadePoint: 0.25, // Start fading 1/4 of the way down the list (same as calendar/weather)
        manualRefreshCooldown: 30 * 1000, // Manual (e.g. GPIO) refreshes within this time of the last refresh are ignored

        // What this entry shows: "sailings" (the list) or "map"
        type: "sailings",

        // Map view (type: "map"). Required in config.js, no defaults: mapUpperLeft and mapLowerRight
        // ({ lat, lon } in decimal degrees). The height follows the area's aspect ratio
        mapWidth: 400,
        mapDetail: "auto", // "auto" | "low" | "medium" | "high"
        mapLayers: { depth: true, contours: true, coastline: true },
        mapColors: {
            land: "#333333",
            water: "#1f3a52",
            depth: ["#1a3247", "#162b3d", "#122433", "#0e1d2a", "#0a1620", "#060f17"], // 30, 60, 120, 180, 300, 600 ft
            contour: "rgba(0,0,0,0.25)",
            coastline: "#626e78"
        },
        mapLineWidths: { coastline: 1, contour: 0.5 },
        mapEdgeFade: 0.04, // share of each side faded to black; 0 = off

        // Ferry and terminal markers on the map (sizes in px; the mirror's screen size dictates the right values)
        mapMarkerSize: 14,
        mapLabelSize: 11,
        mapMarkerColors: {
            otherBoat: "#3d3d3d",   // boats not on this route (deliberately faint)
            dockedBoat: "#9a9a9a",  // route boats at a dock
            toDeparting: "#7fa7c9", // route boats heading to the departing terminal
            toArriving: "#d8c8a0",  // route boats heading to the arriving terminal
            departingTerminal: "#7fa7c9",
            arrivingTerminal: "#d8c8a0",
            otherTerminal: "#666"
        },
        mapIcons: { underway: "fa-location-arrow", docked: "fa-anchor", terminal: "fa-square" } // Font Awesome names
    },

    // One full cycle of the title icon pulse; must match the CSS animation duration
    pulseCycleMs: 2000,

    start () {
        if (this.config.type === "map") {
            this.map = { status: "loading" };
            this.positions = null;
            this.registerMap();
            return;
        }

        this.sailings = [];
        this.loaded = false;
        this.error = null;
        this.departingTerminalName = "";
        this.arrivingTerminalName = "";
        this.lastUpdated = "";
        this.fetching = false;
        this.pulseUntil = 0;
        this.routeKey = `${this.config.departingTerminalID}-${this.config.arrivingTerminalID}`;
        this.register();
    },

    getTemplate () {
        return this.config.type === "map" ? "MMM-WaStateFerry-map.njk" : "MMM-WaStateFerry.njk";
    },

    getTemplateData () {
        if (this.config.type === "map") {
            return { map: this.map, edgeFadePercent: Math.round(this.config.mapEdgeFade * 1000) / 10, markersHtml: this.markersHtml() };
        }


        // Add display-only fields: color classes and bottom-fade opacity
        const sailings = this.sailings.map((sailing, index) => ({
            ...sailing,
            delayClass: this.delayClass(sailing.delayMinutes),
            // Space colors only for upcoming, non-cancelled sailings (departed counts are uncolored)
            spaceClass: sailing.hasDeparted || sailing.isCancelled ? "" : this.spaceClass(sailing.driveUpSpaceCount, sailing.maxSpaceCount),
            // Fade multiplies with the departed-row dimming (0.4) instead of overriding it
            opacity: this.config.fade
                ? Math.round(this.fadeOpacity(index, this.sailings.length) * (sailing.hasDeparted ? 0.4 : 1) * 100) / 100
                : null
        }));

        return {
            loaded: this.loaded,
            error: this.error,
            sailings: sailings,
            departingTerminalName: this.departingTerminalName,
            arrivingTerminalName: this.arrivingTerminalName,
            lastUpdated: this.lastUpdated,
            fetching: this.fetching
        };
    },

    // Color class for the estimated departure time, by delay in minutes
    delayClass (delayMinutes) {
        if (delayMinutes == null || delayMinutes < 5) return "";
        if (delayMinutes <= 30) return "delay-yellow";
        if (delayMinutes <= 60) return "delay-red";
        return "delay-purple";
    },

    // Color class for drive-up spaces, by percentage of spaces left
    spaceClass (spaceCount, maxSpaceCount) {
        if (spaceCount == null || !maxSpaceCount) return "";
        const percentLeft = (spaceCount / maxSpaceCount) * 100;
        if (percentLeft <= 0) return "space-purple";
        if (percentLeft <= 10) return "space-red";
        if (percentLeft <= 50) return "space-yellow";
        return "";
    },

    // Row opacity for the bottom fade (same formula as the default calendar/weather modules)
    fadeOpacity (index, count) {
        if (!this.config.fade || this.config.fadePoint >= 1) return 1;
        const startingPoint = count * Math.max(this.config.fadePoint, 0);
        if (index < startingPoint) return 1;
        return 1 - (index - startingPoint) / (count - startingPoint);
    },

    getStyles () {
        return ["MMM-WaStateFerry.css"];
    },

    socketNotificationReceived (notification, payload) {
        if (this.config.type === "map") {
            this.mapNotificationReceived(notification, payload);
            return;
        }

        // One route per installation: the helper broadcasts to every page, so check the route first
        if (payload && payload.routeKey && payload.routeKey !== this.routeKey) {
            const notice = `Only one ferry route is supported per MagicMirror. This entry's route (${this.routeKey}, `
                + `departing-arriving terminal IDs) is ignored; the active route is ${payload.routeKey}. See the README.`;
            if (this.error !== notice) {
                this.error = notice;
                this.loaded = true;
                this.updateDom(0);
            }
            return;
        }

        if (notification === "FETCH_STARTED") {
            // Pulse the title icon while fetching; toggled on the existing element so data stays on screen
            if (this.loaded) {
                this.fetching = true;
                this.pulseUntil = Date.now() + this.pulseCycleMs;
                const icon = document.querySelector(`#${this.identifier} .ferry-icon`);
                if (icon) icon.classList.add("pulsing");
            }
        } else if (notification === "FERRY_SCHEDULE") {
            this.sailings = payload.sailings;
            this.departingTerminalName = payload.departingTerminalName;
            this.arrivingTerminalName = payload.arrivingTerminalName;
            this.lastUpdated = payload.lastUpdated;
            // Fade in on first load only; later refreshes swap in without the fade-out/in
            const firstLoad = !this.loaded;
            this.loaded = true;
            this.error = null;
            this.finishFetch(firstLoad ? this.config.animationSpeed : 0);
        } else if (notification === "FERRY_ERROR") {
            this.error = payload.message;
            this.finishFetch(this.config.animationSpeed);
        }
    },

    // Stop the icon pulse (after at least one full cycle) and render the latest data
    finishFetch (speed) {
        clearTimeout(this.finishTimer);
        this.finishTimer = setTimeout(() => {
            this.fetching = false;
            this.updateDom(speed);
        }, Math.max(0, this.pulseUntil - Date.now()));
    },

    // Map pages register once with their map settings; the helper builds (or reuses) the map SVG.
    // Nested defaults are merged here so partial settings (e.g. one color) keep the other defaults.
    registerMap () {
        const merged = name => ({ ...this.defaults[name], ...this.config[name] });
        this.sendSocketNotification("REGISTER", {
            type: "map",
            identifier: this.identifier,
            mapUpperLeft: this.config.mapUpperLeft,
            mapLowerRight: this.config.mapLowerRight,
            mapWidth: this.config.mapWidth,
            mapDetail: this.config.mapDetail,
            mapLayers: merged("mapLayers"),
            mapColors: merged("mapColors"),
            mapLineWidths: merged("mapLineWidths"),
            mapEdgeFade: this.config.mapEdgeFade,
            mapMarkerSize: this.config.mapMarkerSize,
            mapLabelSize: this.config.mapLabelSize,
            mapMarkerColors: merged("mapMarkerColors"),
            mapIcons: merged("mapIcons")
        });
    },

    // Map replies are for this map only (several maps can be on screen); positions are for every map
    mapNotificationReceived (notification, payload) {
        if (!payload) return;
        if (notification === "MAP_POSITIONS") {
            this.positions = payload;
            this.renderMarkers();
            return;
        }
        if (payload.identifier !== this.identifier) return;
        if (notification === "MAP_READY") {
            this.map = { status: "ready", src: this.file(`map_cache/${payload.file}`), width: payload.width, height: payload.height, view: payload.view };
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "MAP_ERROR") {
            this.map = { status: "error", errors: payload.errors };
            this.updateDom(this.config.animationSpeed);
        }
    },

    // Update only the marker overlay, so position updates never re-render the map image
    renderMarkers () {
        const overlay = document.querySelector(`#${this.identifier} .MMM-WaStateFerry-map-markers`);
        if (overlay) overlay.innerHTML = this.markersHtml();
    },

    // HTML for ferry and terminal markers, placed with the same projection the map SVG was drawn with
    markersHtml () {
        if (!this.map || this.map.status !== "ready" || !this.map.view || !this.positions) return "";
        const { west, north, k, scale, width, height } = this.map.view;
        const merged = name => ({ ...this.defaults[name], ...this.config[name] });
        const colors = merged("mapMarkerColors");
        const icons = merged("mapIcons");
        const iconSize = this.config.mapMarkerSize;
        const labelSize = this.config.mapLabelSize;
        const escape = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
        const place = (lon, lat) => [(lon - west) * k * scale, (north - lat) * scale];
        const visible = ([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height;
        const marker = (x, y, cls, color, icon, rotate, label, labelPos) => `<div class="map-marker ${cls}" `
            + `style="left: ${x.toFixed(1)}px; top: ${y.toFixed(1)}px; color: ${color}; font-size: ${iconSize}px;">`
            + `<i class="fa-solid ${icon}"${rotate === null ? "" : ` style="transform: rotate(${rotate}deg);"`}></i>`
            + `<span class="map-label ${labelPos}" style="font-size: ${labelSize}px;">${escape(label)}</span></div>`;

        const parts = [];
        // Terminals: square marker, full name above
        for (const t of this.positions.terminals || []) {
            const xy = place(t.lon, t.lat);
            if (!visible(xy)) continue;
            const color = t.kind === "departing" ? colors.departingTerminal : t.kind === "arriving" ? colors.arrivingTerminal : colors.otherTerminal;
            parts.push(marker(xy[0], xy[1], "map-terminal", color, icons.terminal, null, t.label, "above"));
        }
        // Vessels: arrow rotated to the heading (the icon points north-east, so subtract 45°), anchor at a dock; abbreviation below
        const vesselColor = { other: colors.otherBoat, docked: colors.dockedBoat, toDeparting: colors.toDeparting, toArriving: colors.toArriving };
        for (const v of this.positions.vessels || []) {
            const xy = place(v.lon, v.lat);
            if (!visible(xy)) continue;
            const docked = v.state === "docked";
            parts.push(marker(xy[0], xy[1], `map-vessel state-${v.state}`, vesselColor[v.state] || colors.otherBoat,
                docked ? icons.docked : icons.underway, docked ? null : Math.round(v.heading - 45), v.label, "below"));
        }
        return parts.join("");
    },

    // Register once with the helper, which runs the fetch cycle for every page (weather-module pattern)
    register () {
        const settings = {
            departingTerminalID: this.config.departingTerminalID,
            arrivingTerminalID: this.config.arrivingTerminalID,
            apiKey: this.config.apiKey,
            maxSailings: this.config.maxSailings,
            updateInterval: this.config.updateInterval,
            manualRefreshCooldown: this.config.manualRefreshCooldown
        };

        // Pass prediction DB settings only if present in config.js (presence enables DB logging)
        ["predictionDbUser", "predictionDbPass", "predictionDbHost", "predictionDbName", "predictionDbPort"].forEach(key => {
            if (key in this.config) settings[key] = this.config[key];
        });

        this.sendSocketNotification("REGISTER", settings);
    }
});