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
        manualRefreshCooldown: 30 * 1000 // Manual (e.g. GPIO) refreshes within this time of the last refresh are ignored
    },

    // One full cycle of the title icon pulse; must match the CSS animation duration
    pulseCycleMs: 2000,

    start () {
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
        return "MMM-WaStateFerry.njk";
    },

    getTemplateData () {
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