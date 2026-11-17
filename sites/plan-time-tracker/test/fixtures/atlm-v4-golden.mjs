// Requirements available before first start. One operation per independently testable behavior.
export const goldenCases = [
  ["ApiShip exposes nine independent lookups and one shipment command", "ApiShip", "FOREIGN", "API", 9, 1],
  ["ApiShip exposes one lookup and nine independent shipment commands", "ApiShip", "FOREIGN", "API", 1, 9],
  ["Telegram bot reads updates", "Telegram", "FOREIGN", "API", 1, 0],
  ["Telegram bot sends a message", "Telegram", "FOREIGN", "API", 0, 1],
  ["Team controls its PostgreSQL schema in managed cloud, query balance", "PostgreSQL", "OWNED", "DATASTORE", 1, 0],
  ["Team changes rows in its Redis keyspace", "Redis", "OWNED", "DATASTORE", 0, 1],
  ["Read partner-owned SQL view", "PostgreSQL", "FOREIGN", "DATASTORE", 1, 0],
  ["GET triggers a remote payment", "Billing", "FOREIGN", "API", 0, 1],
  ["Read-before-write within one atomic debit", "Accounts", "OWNED", "SERVICE", 0, 1],
  ["A thousand pages of the same lookup", "Search", "FOREIGN", "API", 1, 0],
  ["Publish a message to a project-owned queue", "Events", "OWNED", "QUEUE", 0, 1],
  ["Read status and create shipment", "Shipments", "FOREIGN", "API", 1, 1],
  ["Fifty report lookups and fifty distinct report commands", "Reports", "OWNED", "SERVICE", 50, 50],
  ["Read OAuth provider metadata", "Identity", "FOREIGN", "PLATFORM", 1, 0],
  ["Read-only SDK inspection", "Partner SDK", "FOREIGN", "SDK", 1, 0],
  ["Pure calculation without independent contract", "", null, null, 0, 0],
];
export function goldenBoundary([requirement, name, contractControl, role, reads, writes]) {
  if (!name) return [];
  const operations = Array.from({length: reads + writes}, (_, i) => {
    const action = i < reads ? "READ" : "WRITE";
    return {id: "op-" + i, description: name + " behavior " + i, evidence: requirement,
      action, work: "USE", contractState: "KNOWN", retryPolicy: "EXISTING",
      idempotency: action === "READ" ? "NOT_APPLICABLE" : "EXISTING", recovery: "EXISTING",
      authType: "API_KEY", accessState: "AVAILABLE", verificationScenarioIds: ["check"]};
  });
  return [{id: "target", name, contractControl, role, evidence: requirement, operations}];
}
export const exceptionalCases = [
  ["Exact duplicate operation", (t,o) => t.systemBoundaries[0].operations.push({...o}), "READY"],
  ["Conflicting ID", (t,o) => t.systemBoundaries[0].operations.push({...o, work:"ADD"}), "INVALID"],
  ["Identical behavior with new ID", (t,o) => t.systemBoundaries[0].operations.push({...o,id:"alias"}), "INVALID"],
  ["Absent verification target", (t,o) => {o.verificationScenarioIds=["absent"];}, "INVALID"],
  ["Unexplained unknown contract", (t,o) => {o.contractState="UNKNOWN";}, "INCOMPLETE"],
  ["Missing required operation action", (t,o) => {delete o.action;}, "INCOMPLETE"],
];
