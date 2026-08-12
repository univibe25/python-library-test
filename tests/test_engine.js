// Engine sanity tests, run with: node tests/test_engine.js
const path = require("path");
const fs = require("fs");
const E = require("../src/draft_optimizer/web/engine.js");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("ok  " + name);
  else {
    failures += 1;
    console.error("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

// --- snake math ---
check("snake r1 pick1 -> team 0", E.teamOnClock(0, 10) === 0);
check("snake r1 pick10 -> team 9", E.teamOnClock(9, 10) === 9);
check("snake r2 pick11 -> team 9", E.teamOnClock(10, 10) === 9);
check("snake r2 pick20 -> team 0", E.teamOnClock(19, 10) === 0);
check("next pick slot0 after 0 is 19", E.nextPickForTeam(0, 1, 10, 150) === 19);

// --- replacement ranks match research heuristics ---
const r10 = E.replacementRanks(10);
check("10-team QB repl ~12", r10.QB === 12);
check("10-team RB repl ~29", r10.RB === 29, String(r10.RB));
const r12 = E.replacementRanks(12);
check("12-team RB repl ~34", r12.RB === 34, String(r12.RB));

// --- real data ---
const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../src/draft_optimizer/web/data/players-half.json"))
);
const config = {
  teams: 10,
  rounds: 15,
  mySlot: 4, // 0-based -> pick 5
  scoring: "half",
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BN: 6 },
};
const pool = E.buildPool(data.players, config);
check("pool has 200+ players", pool.length > 200);
check("all top-100 have points", pool.filter((p) => p.rank <= 100).every((p) => p.points > 0));
const top = pool.find((p) => p.rank === 1);
check("top player has positive VOR", top.vor > 50, `vor=${top.vor}`);
check("top player has ADP", top.estAdp != null && top.estAdp < 5, `adp=${top.estAdp}`);

// --- round 1: should recommend an elite RB/WR, never K/DST/QB-late ---
let res = E.recommend(pool, new Set(), [], { currentPick: 4, config });
const best = res.recommendations[0].player;
check("round 1 recommends RB or WR", best.pos === "RB" || best.pos === "WR", best.pos + " " + best.name);
check("round 1 rec is a top-8 rank", best.rank <= 8, `rank=${best.rank}`);
check(
  "no K/DST in early recommendations",
  res.recommendations.every((r) => r.player.pos !== "K" && r.player.pos !== "DST")
);
check("has reasons", res.recommendations[0].reasons.length > 0);

// --- simulate a full 10-team draft where 9 opponents pick by ADP/rank ---
function bestByMarket(available) {
  let b = null;
  for (const p of available) {
    const price = p.estAdp != null ? p.estAdp : p.rank + 15;
    if (b === null || price < b.price) b = { p, price };
  }
  return b.p;
}
const drafted = new Set();
const rosters = Array.from({ length: 10 }, () => []);
const totalPicks = 150;
for (let pick = 0; pick < totalPicks; pick++) {
  const team = E.teamOnClock(pick, 10);
  const available = pool.filter((p) => !drafted.has(p.id));
  let choice;
  if (team === config.mySlot) {
    const r = E.recommend(pool, drafted, rosters[team], { currentPick: pick, config });
    check(`pick ${pick + 1}: engine returned a recommendation`, r.recommendations.length > 0);
    if (!r.recommendations.length) break;
    choice = r.recommendations[0].player;
  } else {
    // Opponents draft roughly by market with light positional sanity:
    // no 2nd K/DST, no 3rd QB/TE, K/DST only late.
    const round = Math.floor(pick / 10) + 1;
    const teamPos = (pos) => rosters[team].filter((x) => x.pos === pos).length;
    const ok = available.filter((p) => {
      if ((p.pos === "K" || p.pos === "DST") && (round < 13 || teamPos(p.pos) >= 1)) return false;
      if (p.pos === "QB" && teamPos("QB") >= 2) return false;
      if (p.pos === "TE" && teamPos("TE") >= 2) return false;
      return rosters[team].length < 15;
    });
    choice = bestByMarket(ok.length ? ok : available);
  }
  drafted.add(choice.id);
  rosters[team].push(choice);
}

const mine = rosters[config.mySlot];
const posCount = (pos) => mine.filter((p) => p.pos === pos).length;
console.log(
  "\nMy simulated roster (slot 5 of 10, half-PPR):\n" +
    mine
      .map(
        (p, i) =>
          `  R${i + 1}  ${p.pos.padEnd(3)} ${p.name} (rank ${p.rank}, ${p.points} pts, bye ${p.bye})`
      )
      .join("\n") + "\n"
);
check("drafted 15 players", mine.length === 15, String(mine.length));
check("exactly 1 K", posCount("K") === 1, String(posCount("K")));
check("exactly 1 DST", posCount("DST") === 1, String(posCount("DST")));
check("1-2 QB", posCount("QB") >= 1 && posCount("QB") <= 2, String(posCount("QB")));
check("1-2 TE", posCount("TE") >= 1 && posCount("TE") <= 2, String(posCount("TE")));
check("4+ RB", posCount("RB") >= 4, String(posCount("RB")));
check("4+ WR", posCount("WR") >= 4, String(posCount("WR")));
const kIdx = mine.findIndex((p) => p.pos === "K");
const dIdx = mine.findIndex((p) => p.pos === "DST");
check("K drafted in last 3 rounds", kIdx >= 12, `round ${kIdx + 1}`);
check("DST drafted in last 3 rounds", dIdx >= 12, `round ${dIdx + 1}`);
const qbIdx = mine.findIndex((p) => p.pos === "QB");
check("QB1 not before round 4", qbIdx >= 3, `round ${qbIdx + 1}`);

// Starters should out-point a naive best-available-rank strategy? At minimum,
// total starter points should be substantial.
const starters = E.rosterNeeds(mine, config.roster);
check("all starter slots filled", starters.starterGaps === 0, JSON.stringify(starters.need));

// --- keepers ---
check("pickIndexFor r1 slot4", E.pickIndexFor(4, 1, 10) === 4);
check("pickIndexFor r2 snakes", E.pickIndexFor(4, 2, 10) === 15); // 10 + (10-1-4)
check("pickIndexFor r3", E.pickIndexFor(4, 3, 10) === 24);

// nextPickForTeam skips keeper-consumed picks.
const consumed = new Set([E.pickIndexFor(4, 2, 10)]);
check(
  "next pick skips consumed round",
  E.nextPickForTeam(4, 5, 10, 150, consumed) === E.pickIndexFor(4, 3, 10)
);

// recommend() plans around consumed picks: with my round-2 pick consumed, my
// "next pick" from round 1 should be round 3's.
const resK = E.recommend(pool, new Set(), [], { currentPick: 4, config, consumed });
check(
  "recommend meta uses consumed picks",
  resK.meta.myNextNumber === E.pickIndexFor(4, 3, 10) + 1,
  String(resK.meta.myNextNumber)
);
check("myRemaining excludes consumed", resK.meta.myRemaining === 14, String(resK.meta.myRemaining));

// evaluateKeeper: a top-5 player kept for a round-10 pick is a screaming KEEP.
const stud = pool.filter((p) => p.rank <= 5 && (p.pos === "RB" || p.pos === "WR"))[0];
const evGood = E.evaluateKeeper(pool, config, stud, 10);
check("stud in round 10 is KEEP", evGood.verdict === "KEEP", JSON.stringify(evGood));
check("KEEP surplus is large", evGood.surplus > 30, String(evGood.surplus));

// A mid player kept at his market round is roughly a wash or worse: keeping
// (say) the RB ranked ~60 at a round-2 price should never be a KEEP.
const midRb = pool.filter((p) => p.pos === "RB" && p.rank >= 55 && p.rank <= 75)[0];
const evBad = E.evaluateKeeper(pool, config, midRb, 2);
check("mid RB at round-2 price is not KEEP", evBad.verdict !== "KEEP", JSON.stringify(evBad));
check("alternative reported", evBad.alternative && evBad.alternative.name.length > 0);

// --- end-of-draft grading ---
// Rebuild per-team pick lists (with pick numbers) from the simulated draft.
const teamsPicks = Array.from({ length: 10 }, () => []);
{
  const seen = new Set();
  let overall = 0;
  // Replay: rosters[] preserved pick order per team; recover pick numbers by
  // re-walking the snake order.
  const cursor = rosters.map(() => 0);
  for (let pick = 0; pick < totalPicks; pick++) {
    const team = E.teamOnClock(pick, 10);
    const player = rosters[team][cursor[team]++];
    if (player) teamsPicks[team].push({ player, pickNumber: pick + 1 });
  }
}
const graded = E.evaluateTeams(teamsPicks, config);
check("grades for all teams", graded.length === 10);
check(
  "grades are A-F",
  graded.every((g) => ["A", "B", "C", "D", "F"].includes(g.grade)),
  JSON.stringify(graded.map((g) => g.grade))
);
check(
  "grade distribution is not flat",
  new Set(graded.map((g) => g.grade)).size >= 2
);
const myGrade = graded[config.mySlot];
console.log(
  "grades:", graded.map((g, i) => `T${i + 1}:${g.grade}(${g.starterPts})`).join(" "),
  "| mine:", myGrade.grade
);
check("optimizer team grades B or better", ["A", "B"].includes(myGrade.grade), myGrade.grade);
check("starter pts sane", graded.every((g) => g.starterPts > 800 && g.starterPts < 2500));
check("steal identified for someone", graded.some((g) => g.steal && g.steal.delta > 0));

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
