Module.register("MMM-WaStateFerry", {
    defaults: {
        departingTerminalID: 7,
        arrivingTerminalID: 3,
        apiKey: "",
        maxSailings: 5,
        updateInterval: 5 * 60 * 1000,
        animationSpeed: 1000
    },

    start () {
        this.sailings = [];
        this.loaded = false;
        this.error = null;
        this.departingTerminalName = "";
        this.arrivingTerminalName = "";
        this.lastUpdated = "";
        this.fetchSchedule();
        this.scheduleUpdate();
    },

    getTemplate () {
        return "MMM-WaStateFerry.njk";
    },

    getTemplateData () {
        return {
            loaded: this.loaded,
            error: this.error,
            sailings: this.sailings,
            departingTerminalName: this.departingTerminalName,
            arrivingTerminalName: this.arrivingTerminalName,
            lastUpdated: this.lastUpdated
        };
    },

    getStyles () {
        return ["MMM-WaStateFerry.css"];
    },

    socketNotificationReceived (notification, payload) {
        if (notification === "FERRY_SCHEDULE") {
            this.sailings = payload.sailings;
            this.departingTerminalName = payload.departingTerminalName;
            this.arrivingTerminalName = payload.arrivingTerminalName;
            this.lastUpdated = payload.lastUpdated;
            this.loaded = true;
            this.error = null;
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "FERRY_ERROR") {
            this.error = payload.message;
            this.updateDom(this.config.animationSpeed);
        }
    },

    fetchSchedule () {
        const payload = {
            departingTerminalID: this.config.departingTerminalID,
            arrivingTerminalID: this.config.arrivingTerminalID,
            apiKey: this.config.apiKey,
            maxSailings: this.config.maxSailings
        };

        // Pass prediction DB settings only if present in config.js (presence enables DB logging)
        ["predictionDbUser", "predictionDbPass", "predictionDbHost", "predictionDbName", "predictionDbPort"].forEach(key => {
            if (key in this.config) payload[key] = this.config[key];
        });

        this.sendSocketNotification("GET_SCHEDULE", payload);
    },

    scheduleUpdate () {
        setInterval(() => {
            this.fetchSchedule();
        }, this.config.updateInterval);
    }
});