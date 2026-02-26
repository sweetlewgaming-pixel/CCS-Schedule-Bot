const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDateInput(input) {
  const [monthText, dayText] = String(input).split('/');
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { month, day };
}

function parseTimeInput(inputTime) {
  const text = String(inputTime || '').trim();
  const match = text.match(/^(1[0-2]|[1-9])(?::([0-5][0-9]))?$/);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = match[2] || '00';
  return { hour, minute };
}

function formatScheduleDate(inputDate) {
  const parsed = parseDateInput(inputDate);
  if (!parsed) {
    return inputDate;
  }

  const year = new Date().getFullYear();
  const dt = new Date(Date.UTC(year, parsed.month - 1, parsed.day, 12, 0, 0));
  const weekday = WEEKDAYS[dt.getUTCDay()];
  return `${weekday} ${parsed.month}/${parsed.day}`;
}

function formatScheduleTime(inputTime) {
  const parsed = parseTimeInput(inputTime);
  if (!parsed) {
    return `${inputTime}pm EST`;
  }

  return `${parsed.hour}:${parsed.minute}pm EST`;
}

module.exports = {
  formatScheduleDate,
  formatScheduleTime,
};
