// Map view: turn the live vessel feed into marker data for the map overlay.
// Vessels: in service only, with a state relative to the route. Terminals: with a kind.

// state: "toDeparting" | "toArriving" | "docked" (route boats) | "other"
function vesselState(vessel, routeVesselIDs, departingTerminalID, arrivingTerminalID) {
  if (!routeVesselIDs.has(vessel.VesselID)) return "other";
  if (vessel.AtDock) return "docked";
  if (vessel.ArrivingTerminalID === departingTerminalID) return "toDeparting";
  if (vessel.ArrivingTerminalID === arrivingTerminalID) return "toArriving";
  return "other";
}

function buildVesselPositions({ vessels, routeVesselIDs, departingTerminalID, arrivingTerminalID, reference }) {
  const markers = (Array.isArray(vessels) ? vessels : [])
    .filter(v => v && v.InService && Number.isFinite(v.Latitude) && Number.isFinite(v.Longitude))
    .map(v => ({
      id: v.VesselID,
      // Abbreviation from vesselbasics; fall back to the name if it isn't known yet
      label: reference.abbrevById[v.VesselID] || v.VesselName || "",
      lat: v.Latitude,
      lon: v.Longitude,
      heading: Number.isFinite(v.Heading) ? v.Heading : 0,
      state: vesselState(v, routeVesselIDs, departingTerminalID, arrivingTerminalID)
    }));

  const terminals = reference.terminals.map(t => ({
    id: t.id,
    label: t.name,
    lat: t.lat,
    lon: t.lon,
    kind: t.id === departingTerminalID ? "departing" : t.id === arrivingTerminalID ? "arriving" : "other"
  }));

  return { vessels: markers, terminals };
}

module.exports = { buildVesselPositions, vesselState };
