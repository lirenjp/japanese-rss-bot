import { DAY } from './db.js';

export const SLOTS = [
  { id: 'morning', label: '07:00', hour: 22 },
  { id: 'lunch', label: '12:00', hour: 3 },
  { id: 'evening', label: '20:00', hour: 11 },
];
export const slotAt = now => SLOTS.find(s => s.hour === new Date(now * 1000).getUTCHours())?.id;
export function nextDelivery(slots, now) {
  const day = Math.floor(now / DAY) * DAY;
  const times = SLOTS.filter(s => slots.includes(s.id)).map(s => {
    const time = day + s.hour * 3600;
    return time > now ? time : time + DAY;
  });
  return times.length ? Math.min(...times) : 0;
}
