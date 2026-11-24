// One tracker per article. Undo stays disarmed until a scroll below the threshold.
export function createAutoFinish() {
  let armed = true;
  return {
    observe(progress, position) {
      if (position < 0.9) armed = true;
      if (!armed || progress !== 'reading' || position < 0.9) return null;
      armed = false;
      return {
        progress: 'finished',
        message: 'Marked finished ·',
        undo() { armed = false; return 'reading'; },
      };
    },
  };
}
