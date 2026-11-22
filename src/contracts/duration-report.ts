/**
 * The duration report's candidate range, shared by the admin route that
 * validates the query and the card that offers the field. Analysis only: it is
 * deliberately wider than the persisted attempt cap.
 */
export const DURATION_REPORT_CAP_MIN_MS = 1;
export const DURATION_REPORT_CAP_MAX_MS = 86_400_000;
