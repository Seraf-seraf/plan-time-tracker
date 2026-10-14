// Synthetic browser-only fixture profile. No production identifiers or user data.
export const acceptanceFixture = Object.freeze({
  ownerId: "fixture-owner",
  viewportWidths: Object.freeze([360, 390, 768, 1440]),
  planIds: Object.freeze(["plan-run", "plan-pending", "plan-paused", "plan-done", "plan-empty"]),
  privateRepositoryLabel: "Приватный репозиторий (доступ отозван)",
  longTitle: "U".repeat(180),
  uncertainties: Object.freeze(["lost-response", "server-500", "refresh-get-failure"]),
});
