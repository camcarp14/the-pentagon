// TRADE WINDOW — one 0-10 number for "how good is right now for a leveraged
// long", plus the plain-English answers that go with it.
//
// The point of this file is that the score CANNOT disagree with the directive.
// It is built from the same six gates the arm checklist uses and the same
// ready-plus-trigger condition advice.js requires before it will ever say ENTER,
// so a high score and a "stand aside" call can only ever mean one thing: the
// setup is there but something operational (a dead feed, an unsizeable position)
// is blocking execution. It can never mean the two modules judged the market
// differently.
//
// WHY 0-10 AND NOT 0-100: the regime score is already 0-100 and it measures one
// thing (MSTR trend). This measures the whole tradeability of the moment, and it
// is meant to be read at a glance and acted on, so it gets the coarse scale.
//
// HOW THE POINTS WORK — deliberately simple enough to verify by eye:
//   • 1 point per gate met, out of 6 (5 MSTR trend gates + BTC confirmation).
//     This is the graduated "how close am I" that a downturn needs: it moves
//     from 0 toward 6 while you are waiting, instead of sitting at zero.
//   • +3 when the gates are ALL met AND a trigger is live. This is the real
//     cliff, not a gradient — it is the difference between a good-looking chart
//     and an entry the rules will actually take.
//   • ±1 for how expensive the leverage is (mNAV/beta read). Rich means you are
//     paying up for the same BTC exposure, which is genuinely a worse entry, but
//     it is a tilt and never the deciding factor. Skipped entirely when mNAV is
//     unavailable rather than assumed neutral-and-counted.
//
// LONG ONLY, ON PURPOSE. Every rule in signals.js was written and replayed for
// long MSTR. Inverting them into a short read is not a sign flip — the stop
// logic, the pullback definition and the BTC gate all assume a long. So the
// direction answer is "long" or "no trade", and this file says so out loud
// rather than implying a short is available.

const BAND = [
  { min: 8, key: 'go', label: 'Go', plain: 'Conditions met — this is the window.' },
  { min: 6, key: 'armed', label: 'Almost', plain: 'Setup is built. Waiting on the trigger to fire.' },
  { min: 3, key: 'building', label: 'Building', plain: 'Getting closer, but the trend is not confirmed yet.' },
  { min: 0, key: 'no', label: 'No trade', plain: 'Nothing here. Cash is the position.' },
]

/**
 * @param arm        armChecklist(mstrCandles, btcCandles) result
 * @param pullback   derived.pullback
 * @param breakout   derived.breakout
 * @param torqueRead derived.torqueRead  ({ grade: 'efficient'|'fair'|'rich'|'unknown', text })
 * @param mNav       derived.nav?.mNav   (null when holdings/shares are unknown)
 * @returns { score, max, band, label, plain, gatesPassed, gatesTotal, triggerLive, parts }
 */
export function tradeWindow({ arm, pullback, breakout, torqueRead, mNav } = {}) {
  if (!arm || arm.insufficient) {
    return {
      score: null, max: 10, band: 'unknown', label: 'No read',
      plain: 'Not enough price history to score the window.',
      gatesPassed: null, gatesTotal: null, triggerLive: false, parts: [],
    }
  }

  const gatesTotal = arm.mstr.length + 1 // the five MSTR gates plus BTC confirmation
  const gatesPassed = arm.mstr.filter((g) => g.pass).length + (arm.btc?.pass ? 1 : 0)

  // `arm.ready` is regime-uptrend AND BTC-aligned — the exact pair advice.js
  // requires alongside a trigger before it will size an entry. Gating the
  // trigger points on it is what stops a breakout inside a downtrend from
  // scoring like a live setup.
  const triggerLive = !!arm.ready && (pullback?.stage === 'trigger' || !!breakout?.active)

  const parts = [
    { key: 'gates', label: `${gatesPassed} of ${gatesTotal} gates`, points: gatesPassed },
    { key: 'trigger', label: triggerLive ? 'trigger live' : 'no live trigger', points: triggerLive ? 3 : 0 },
  ]

  // GRADE NAMES COME FROM torqueRead(), NOT FROM THIS FILE'S MEMORY OF THEM.
  // torque.js emits 'efficient' | 'fair' | 'rich' | 'unknown'. This branch used
  // to test for 'cheap', a grade nothing has ever produced, so the documented
  // "+1 when the leverage is cheap" was unreachable: an efficient read scored
  // the same 0 as a fair one, and only the -1 penalty could ever fire. The
  // scale was silently 0-9 with a downward tilt, not the 0-10 above.
  let leveragePoints = 0
  if (mNav != null && torqueRead?.grade && torqueRead.grade !== 'unknown') {
    leveragePoints = torqueRead.grade === 'efficient' ? 1 : torqueRead.grade === 'rich' ? -1 : 0
    parts.push({ key: 'leverage', label: `leverage ${torqueRead.grade}`, points: leveragePoints })
  }

  const raw = gatesPassed + (triggerLive ? 3 : 0) + leveragePoints
  const score = Math.max(0, Math.min(10, raw))
  const band = BAND.find((b) => score >= b.min)

  return {
    score, max: 10, band: band.key, label: band.label, plain: band.plain,
    gatesPassed, gatesTotal, triggerLive, parts,
  }
}

/**
 * Direction, in the only two values these rules can honestly produce. Reads the
 * DIRECTIVE rather than the score, so the row can never tell you to go long
 * while the call above it says stand aside.
 */
export function directionRead(action) {
  switch (action) {
    case 'ENTER': return { text: 'Long', tone: 'go', note: 'open a new long' }
    case 'ADD': return { text: 'Long', tone: 'go', note: 'add to the existing long' }
    case 'HOLD': return { text: 'Long', tone: 'hold', note: 'already on — let it run' }
    case 'TRIM': return { text: 'Long', tone: 'warn', note: 'reduce, do not add' }
    case 'EXIT': return { text: 'Close it', tone: 'bad', note: 'flatten the long' }
    case 'STOP_OUT': return { text: 'Close it', tone: 'bad', note: 'stop is hit — sell' }
    default: return { text: 'No trade', tone: 'flat', note: 'cash' }
  }
}
