export const UI_TIME_ZONES = [
  { value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { value: 'Asia/Omsk', label: 'Омск (UTC+6)' },
];
export function resolveUiTimeZone(value) {
  return UI_TIME_ZONES.some((option) => option.value === value) ? value : 'Asia/Omsk';
}
