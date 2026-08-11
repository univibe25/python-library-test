/* Draft recommendation engine.
 *
 * Strategy encoded here (from expert consensus research):
 *  - Value Over Replacement (VOR): player value = projected points minus the
 *    projected points of the "replacement level" player at that position for
 *    this league size. Beats raw points because it prices positional scarcity.
 *  - ADP wait-rule: if a player's ADP says he'll still be on the board at your
 *    next pick, you can wait on him; prefer players about to disappear.
 *  - Tier urgency: take from the tier that's about to vanish.
 *  - Roster gates: K/DST only in the last rounds, QB2/TE2 late or never,
 *    starters before bench.
 *  - Bye weeks: tiebreaker only — small penalty for stacking a bye at one
 *    position, never a reason to skip a clearly better player.
 *  - Late rounds: chase ceiling (upside) over floor.
 */
(function (root) {
  "use strict";

  var FLEX_ELIGIBLE = { RB: true, WR: true, TE: true };
  var POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

  // ---------- snake draft math ----------

  function teamOnClock(pickIndex, teams) {
    var round = Math.floor(pickIndex / teams);
    var idx = pickIndex % teams;
    return round % 2 === 0 ? idx : teams - 1 - idx;
  }

  function nextPickForTeam(team, fromPick, teams, totalPicks) {
    for (var p = fromPick; p < totalPicks; p++) {
      if (teamOnClock(p, teams) === team) return p;
    }
    return null;
  }

  // ---------- pool preparation ----------

  // Replacement ranks per position for an N-team league (starters + modest
  // bench demand; FLEX demand folded into RB/WR).
  function replacementRanks(teams) {
    return {
      QB: teams + 2,
      RB: Math.round(2.5 * teams + 4),
      WR: Math.round(2.5 * teams + 4),
      TE: teams + 2,
      K: teams,
      DST: teams,
    };
  }

  // Resolve a player's ADP for this league size: exact table if we have it,
  // otherwise scale the nearest size (ADP round position is roughly stable
  // across league sizes), otherwise Sleeper's (~12-team) ADP, otherwise null.
  function resolveAdp(player, teams) {
    var table = player.adp || {};
    var exact = table[String(teams)];
    if (exact) return exact;
    var sizes = Object.keys(table).map(Number);
    if (sizes.length) {
      sizes.sort(function (a, b) {
        return Math.abs(a - teams) - Math.abs(b - teams);
      });
      var src = sizes[0];
      return ((table[String(src)] - 1) / src) * teams + 1;
    }
    if (player.sleeper_adp) return ((player.sleeper_adp - 1) / 12) * teams + 1;
    return null;
  }

  // Fill in projected points for deep players that lack projections by
  // decaying from the last projected player at the position. Keeps VOR
  // meaningful for late bench picks without inventing precision.
  function fillMissingPoints(players) {
    POSITIONS.forEach(function (pos) {
      var atPos = players
        .filter(function (p) {
          return p.pos === pos;
        })
        .sort(function (a, b) {
          return a.rank - b.rank;
        });
      var lastPts = null;
      var gap = 0;
      atPos.forEach(function (p) {
        if (p.points != null) {
          lastPts = p.points;
          gap = 0;
        } else if (lastPts != null) {
          gap += 1;
          p.points = Math.max(0, Math.round((lastPts - 2.5 * gap) * 10) / 10);
          p.pointsEstimated = true;
        } else {
          p.points = 0;
          p.pointsEstimated = true;
        }
      });
    });
  }

  // Enrich raw player data with estAdp / vor / tier bookkeeping for a league.
  function buildPool(rawPlayers, config) {
    var players = rawPlayers.map(function (p) {
      return Object.assign({}, p);
    });
    fillMissingPoints(players);

    var ranks = replacementRanks(config.teams);
    var byPos = {};
    POSITIONS.forEach(function (pos) {
      byPos[pos] = players
        .filter(function (p) {
          return p.pos === pos;
        })
        .sort(function (a, b) {
          return b.points - a.points;
        });
    });

    players.forEach(function (p) {
      var posPool = byPos[p.pos] || [];
      var replIdx = Math.min(ranks[p.pos] - 1, posPool.length - 1);
      var replPts = posPool.length ? posPool[replIdx].points : 0;
      p.vor = Math.round((p.points - replPts) * 10) / 10;
      p.estAdp = resolveAdp(p, config.teams);
      p.posRankNum = posPool.indexOf(p) + 1;
    });
    return players;
  }

  // ---------- roster accounting ----------

  // Assign a team's players to starting slots greedily (best points first),
  // then FLEX, then bench. Returns slot usage and unfilled starter counts.
  function rosterNeeds(teamPlayers, rosterConfig) {
    var slots = rosterConfig; // {QB,RB,WR,TE,FLEX,K,DST,BN}
    var used = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, BN: 0 };
    var sorted = teamPlayers.slice().sort(function (a, b) {
      return b.points - a.points;
    });
    sorted.forEach(function (p) {
      if (used[p.pos] < (slots[p.pos] || 0)) used[p.pos] += 1;
      else if (FLEX_ELIGIBLE[p.pos] && used.FLEX < (slots.FLEX || 0)) used.FLEX += 1;
      else used.BN += 1;
    });
    var need = {};
    POSITIONS.forEach(function (pos) {
      need[pos] = Math.max(0, (slots[pos] || 0) - used[pos]);
    });
    need.FLEX = Math.max(0, (slots.FLEX || 0) - used.FLEX);
    var starterGaps =
      need.QB + need.RB + need.WR + need.TE + need.K + need.DST + need.FLEX;
    return { need: need, used: used, starterGaps: starterGaps };
  }

  function countPos(teamPlayers, pos) {
    return teamPlayers.filter(function (p) {
      return p.pos === pos;
    }).length;
  }

  // ---------- recommendation ----------

  // P(player already drafted by overall pick #n), from ADP. Logistic curve:
  // ~50/50 at ADP == pick, steep over ~±4 picks.
  function pGoneBy(estAdp, pickNumber) {
    if (estAdp == null) return 0.1;
    return 1 / (1 + Math.exp(-(pickNumber - estAdp) / 4));
  }

  /**
   * Produce pick recommendations.
   *
   * @param pool       all players (from buildPool)
   * @param draftedIds Set of drafted player ids
   * @param myPlayers  players on the user's team
   * @param ctx        {currentPick (0-based overall), config}
   * @returns {recommendations: [...], notes: [...]}
   */
  function recommend(pool, draftedIds, myPlayers, ctx) {
    var config = ctx.config;
    var teams = config.teams;
    var totalPicks = teams * config.rounds;
    var roster = config.roster;
    var currentPick = ctx.currentPick; // 0-based
    var pickNumber = currentPick + 1; // 1-based, comparable to ADP
    var round = Math.floor(currentPick / teams) + 1;

    var myNext = nextPickForTeam(config.mySlot, currentPick + 1, teams, totalPicks);
    var myNextNumber = myNext == null ? totalPicks + teams : myNext + 1;

    // How many picks I still have, counting this one.
    var myRemaining = 0;
    for (var p = currentPick; p < totalPicks; p++) {
      if (teamOnClock(p, teams) === config.mySlot) myRemaining += 1;
    }

    var available = pool.filter(function (pl) {
      return !draftedIds.has(pl.id);
    });

    var needs = rosterNeeds(myPlayers, roster);
    var need = needs.need;
    var qbCount = countPos(myPlayers, "QB");
    var teCount = countPos(myPlayers, "TE");
    var rosterFull = myPlayers.length >= Object.keys(roster).reduce(function (s, k) {
      return s + roster[k];
    }, 0);

    // --- positional eligibility gates ---
    var lastRounds = round >= config.rounds - 1;
    var specialNeeded = need.K + need.DST;
    var eligible = function (pl) {
      if (rosterFull) return false;
      if (pl.pos === "K" || pl.pos === "DST") {
        if (pl.pos === "K" && countPos(myPlayers, "K") >= (roster.K || 0)) return false;
        if (pl.pos === "DST" && countPos(myPlayers, "DST") >= (roster.DST || 0)) return false;
        // Only in the last rounds, or when we're out of picks for anything else.
        return lastRounds || myRemaining <= specialNeeded + 1;
      }
      if (pl.pos === "QB") {
        if (qbCount >= 2) return false;
        if (qbCount >= 1 && (round < config.rounds - 3 || needs.starterGaps > myRemaining - 2))
          return false;
        // 1-QB leagues: no QB in rounds 1-3 unless an elite one has fallen
        // well past his market price (1.5+ rounds).
        if (
          qbCount === 0 &&
          round <= 3 &&
          !(pl.estAdp != null && pl.estAdp <= pickNumber - 1.5 * teams)
        )
          return false;
      }
      if (pl.pos === "TE") {
        if (teCount >= 2) return false;
        if (teCount >= 1 && (round < config.rounds - 3 || needs.starterGaps > myRemaining - 2))
          return false;
      }
      // If remaining picks are exactly what's needed to fill starter gaps,
      // only allow positions that fill a gap.
      if (needs.starterGaps >= myRemaining) {
        var fills =
          need[pl.pos] > 0 || (FLEX_ELIGIBLE[pl.pos] && need.FLEX > 0);
        if (!fills) return false;
      }
      return true;
    };

    // Tier bookkeeping among available players.
    var tierLeft = {}; // pos -> tier -> count
    var bestNextTierPts = {}; // pos -> tier -> best points of the NEXT tier
    POSITIONS.forEach(function (pos) {
      tierLeft[pos] = {};
      bestNextTierPts[pos] = {};
      var avail = available.filter(function (pl) {
        return pl.pos === pos && pl.tier != null;
      });
      avail.forEach(function (pl) {
        tierLeft[pos][pl.tier] = (tierLeft[pos][pl.tier] || 0) + 1;
      });
      avail.forEach(function (pl) {
        var nt = pl.tier + 1;
        while (nt <= 20 && !tierLeft[pos][nt]) nt += 1;
        var best = 0;
        avail.forEach(function (q) {
          if (q.tier === nt && q.points > best) best = q.points;
        });
        bestNextTierPts[pos][pl.tier] = best;
      });
    });

    // Best points at each position likely still available at my next pick
    // (VONA — value over next available).
    var bestAtNext = {};
    POSITIONS.forEach(function (pos) {
      var best = 0;
      available.forEach(function (pl) {
        if (pl.pos !== pos) return;
        if (pGoneBy(pl.estAdp, myNextNumber) < 0.5 && pl.points > best) best = pl.points;
      });
      bestAtNext[pos] = best;
    });

    var myByes = {}; // pos -> {bye: count} for players I roster
    myPlayers.forEach(function (pl) {
      if (pl.bye == null) return;
      myByes[pl.pos] = myByes[pl.pos] || {};
      myByes[pl.pos][pl.bye] = (myByes[pl.pos][pl.bye] || 0) + 1;
    });

    var benchPhase = needs.starterGaps - need.K - need.DST <= 0;
    var lateUpsideRounds = round >= config.rounds - 5 && benchPhase;

    var candidates = available
      .filter(eligible)
      .sort(function (a, b) {
        return a.rank - b.rank;
      })
      .slice(0, 60);

    var scored = candidates.map(function (pl) {
      var reasons = [];
      var score = 0;

      // Need weighting on VOR.
      var fillsStarter = need[pl.pos] > 0 || (FLEX_ELIGIBLE[pl.pos] && need.FLEX > 0);
      var needWeight;
      if (fillsStarter) {
        needWeight = 1.0;
      } else if (FLEX_ELIGIBLE[pl.pos]) {
        // Bench RB/WR/TE depth matters, but with diminishing returns as one
        // position stacks up — keeps the bench balanced (~3 RB / 2-3 WR).
        var startersAtPos = (roster[pl.pos] || 0) + (pl.pos === "TE" ? 0 : 1);
        var extra = Math.max(0, countPos(myPlayers, pl.pos) - startersAtPos);
        needWeight = 0.7 * Math.pow(0.65, extra);
        // Don't stockpile bench depth while starter slots sit open elsewhere.
        if (needs.starterGaps - need.K - need.DST > 0) needWeight *= 0.5;
      } else {
        needWeight = 0.3; // backup QB/K/DST barely matters
      }
      var effVor = pl.vor * needWeight;
      score += effVor;
      if (pl.vor > 0) {
        reasons.push(
          "+" + pl.vor.toFixed(0) + " pts over replacement " + pl.pos +
          (needWeight < 1 ? " (bench depth)" : "")
        );
      }
      if (fillsStarter && need[pl.pos] > 0) {
        score += 4;
        reasons.push("Fills your open " + pl.pos + " starter slot");
      } else if (fillsStarter && need.FLEX > 0) {
        score += 2;
        reasons.push("Fills your open FLEX slot");
      }

      // Urgency: value lost if I wait until my next pick, weighted by the
      // probability he's gone by then.
      var gone = pGoneBy(pl.estAdp, myNextNumber);
      var waitLoss = bestAtNext[pl.pos] > 0 ? Math.max(0, pl.points - bestAtNext[pl.pos]) : 8;
      // Beating a positional run only matters in proportion to how much you
      // need the position — don't rush bench depth while starters are open.
      var urgency = Math.min(30, waitLoss) * gone * (fillsStarter ? 1 : needWeight);
      score += urgency;
      if (pl.estAdp != null) {
        if (gone >= 0.75) {
          reasons.push(
            "Likely gone before your next pick (ADP " + pl.estAdp.toFixed(1) +
            ", you pick next at #" + myNextNumber + ")"
          );
        } else if (gone <= 0.25 && waitLoss < 5) {
          reasons.push("Could likely wait — ADP " + pl.estAdp.toFixed(1) + " vs your next pick #" + myNextNumber);
        }
      }

      // Tier urgency: last players of a tier, with a real drop behind them.
      if (pl.tier != null) {
        var left = tierLeft[pl.pos][pl.tier] || 0;
        var drop = pl.points - (bestNextTierPts[pl.pos][pl.tier] || pl.points);
        if (left <= 2 && drop > 5) {
          var bonus = Math.min(12, drop * 0.6);
          score += bonus;
          reasons.push(
            (left === 1 ? "Last player" : "One of the last " + left) +
            " in " + pl.pos + " tier " + pl.tier +
            " — " + drop.toFixed(0) + "-pt drop to next tier"
          );
        }
      }

      // Reach penalty: paying more than a round over market price.
      if (pl.estAdp != null && pl.estAdp > pickNumber + teams) {
        var reach = Math.min(10, (pl.estAdp - pickNumber - teams) * 0.2);
        score -= reach;
        reasons.push("Would be a reach — market price is pick " + pl.estAdp.toFixed(0));
      }

      // Bye conflict: tiebreaker-size penalty only, and only after round 5.
      if (round > 5 && pl.bye != null && myByes[pl.pos] && myByes[pl.pos][pl.bye]) {
        var byePen = pl.pos === "QB" || pl.pos === "TE" ? 5 : 3;
        score -= byePen;
        reasons.push("Shares week-" + pl.bye + " bye with your other " + pl.pos);
      }

      // Late rounds: chase ceiling.
      if (lateUpsideRounds && FLEX_ELIGIBLE[pl.pos]) {
        var spread = pl.best_rank != null ? Math.max(0, pl.rank - pl.best_rank) : 0;
        var upside = Math.min(8, spread * 0.08 + (pl.rank_std || 0) * 0.25);
        if (upside > 2) {
          score += upside;
          reasons.push("Upside pick — some experts rank him #" + pl.best_rank + " overall");
        }
      }

      // Early-QB damper: consensus QB window is rounds 6-10; before that a
      // QB has to be a fallen elite (a full round past ADP) to score well.
      if (pl.pos === "QB" && qbCount === 0 && round < 6) {
        var fell = pl.estAdp != null && pl.estAdp <= pickNumber - teams;
        if (!fell) {
          var damper = (6 - round) * 6;
          score -= damper;
          reasons.push("Early for a QB — the QB window opens around round 6");
        } else {
          reasons.push("Elite QB falling past market price — worth the early pick");
        }
      }

      if (pl.injury) {
        score -= 4;
        reasons.push("Injury flag: " + pl.injury);
      }

      return { player: pl, score: Math.round(score * 10) / 10, reasons: reasons };
    });

    scored.sort(function (a, b) {
      return b.score - a.score;
    });

    // Strategy notes for this pick.
    var notes = [];
    if (round <= 3) {
      notes.push("Rounds 1–3: lock in elite RB/WR value; only an elite QB/TE outlier changes that.");
    }
    if (qbCount === 0 && round >= 6 && round <= 10) {
      notes.push("QB window is open (rounds 6–10) — take one before the good tiers empty.");
    }
    if (need.K + need.DST > 0 && round < config.rounds - 1) {
      notes.push("Hold off on K/DST until the last two rounds — they're streamable.");
    }
    POSITIONS.forEach(function (pos) {
      if (pos === "K" || pos === "DST") return;
      var best = null;
      available.forEach(function (pl) {
        if (pl.pos === pos && (best == null || pl.points > best.points)) best = pl;
      });
      if (best && best.estAdp != null && pGoneBy(best.estAdp, myNextNumber) < 0.25) {
        notes.push(
          "You can wait on " + pos + " — " + best.name +
          " (ADP " + best.estAdp.toFixed(0) + ") should still be there at pick #" + myNextNumber + "."
        );
      }
    });

    return {
      recommendations: scored.slice(0, 8),
      notes: notes,
      meta: {
        round: round,
        pickNumber: pickNumber,
        myNextNumber: myNext == null ? null : myNextNumber,
        myRemaining: myRemaining,
        starterGaps: needs.starterGaps,
        need: need,
      },
    };
  }

  var DraftEngine = {
    teamOnClock: teamOnClock,
    nextPickForTeam: nextPickForTeam,
    replacementRanks: replacementRanks,
    resolveAdp: resolveAdp,
    buildPool: buildPool,
    rosterNeeds: rosterNeeds,
    pGoneBy: pGoneBy,
    recommend: recommend,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = DraftEngine;
  else root.DraftEngine = DraftEngine;
})(typeof self !== "undefined" ? self : this);
