/* Draft Command — app state + UI. Engine logic lives in engine.js. */
(function () {
  "use strict";

  var E = window.DraftEngine;
  var STORAGE_KEY = "draft-command-v1";
  var ROSTER_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST", "BN"];
  var DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BN: 6 };

  var state = {
    config: null, // {scoring, teams, mySlot, rounds, roster, teamNames}
    picks: [], // [{playerId, team}] in overall order
    pool: [],
    poolById: {},
    dataMeta: null,
  };
  var ui = {
    posFilter: "ALL",
    search: "",
    showDrafted: false,
    teamsTab: "rosters",
    openTeams: {},
  };
  // Keepers being configured on the setup screen: [{team, playerId, name, pos, round}]
  var setupKeepers = [];
  var setupData = null; // raw data file for the currently selected scoring

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Player headshot (or team logo for defenses): local cache first, Sleeper
  // CDN as fallback, hidden if neither has a photo.
  function avatarHtml(p, size) {
    var local, cdn;
    if (p.pos === "DST") {
      var team = (p.team || "").toLowerCase();
      if (!team) return "";
      local = "img/teams/" + team + ".png";
      cdn = "https://sleepercdn.com/images/team_logos/nfl/" + team + ".png";
    } else {
      if (!p.sid) return "";
      local = "img/players/" + p.sid + ".jpg";
      cdn = "https://sleepercdn.com/content/nfl/players/thumb/" + p.sid + ".jpg";
    }
    return (
      "<img class='avatar' loading='lazy' width='" + size + "' height='" + size +
      "' src='" + local + "' data-cdn='" + cdn + "' alt='' " +
      "onerror=\"if(!this.dataset.f){this.dataset.f=1;this.src=this.dataset.cdn}else{this.style.visibility='hidden'}\">"
    );
  }

  // ---------- data ----------

  function loadData(scoring) {
    return fetch("data/players-" + scoring + ".json").then(function (r) {
      if (!r.ok) throw new Error("failed to load player data (" + r.status + ")");
      return r.json();
    });
  }

  // ---------- persistence ----------

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ config: state.config, picks: state.picks }));
    } catch (e) { /* storage full/blocked — draft continues in memory */ }
  }
  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  // ---------- derived state ----------

  function draftedIds() {
    var s = new Set();
    state.picks.forEach(function (p) { s.add(p.playerId); });
    return s;
  }
  function keepers() {
    return (state.config && state.config.keepers) || [];
  }
  // Keeper players whose round hasn't been reached yet: off the board for
  // everyone, but already belong to their team.
  function pendingKeepers() {
    var drafted = draftedIds();
    return keepers().filter(function (k) {
      return state.poolById[k.playerId] && !drafted.has(k.playerId);
    });
  }
  function unavailableIds() {
    var s = draftedIds();
    pendingKeepers().forEach(function (k) { s.add(k.playerId); });
    return s;
  }
  // Overall pick indices consumed by keepers (any team).
  function consumedSet() {
    var s = new Set();
    keepers().forEach(function (k) {
      s.add(E.pickIndexFor(k.team, k.round, state.config.teams));
    });
    return s;
  }
  function teamPlayers(team, includePending) {
    var players = state.picks
      .filter(function (p) { return p.team === team; })
      .map(function (p) { return state.poolById[p.playerId]; });
    if (includePending) {
      pendingKeepers().forEach(function (k) {
        if (k.team === team) players.push(state.poolById[k.playerId]);
      });
    }
    return players;
  }
  function currentPick() { return state.picks.length; }
  function totalPicks() { return state.config.teams * state.config.rounds; }
  function draftOver() { return currentPick() >= totalPicks(); }
  function onClock() { return E.teamOnClock(currentPick(), state.config.teams); }
  function isMyTurn() { return !draftOver() && onClock() === state.config.mySlot; }
  function teamName(i) {
    return (state.config.teamNames && state.config.teamNames[i]) || "Team " + (i + 1);
  }

  // ---------- setup screen ----------

  function fillSelect(sel, values, selected) {
    sel.innerHTML = values
      .map(function (v) {
        return '<option value="' + v + '"' + (v === selected ? " selected" : "") + ">" + v + "</option>";
      })
      .join("");
  }

  function rosterFromInputs() {
    var roster = {};
    ROSTER_SLOTS.forEach(function (slot) {
      roster[slot] = Math.max(0, parseInt($("#roster-" + slot).value, 10) || 0);
    });
    return roster;
  }

  function syncRoundsToRoster() {
    var roster = rosterFromInputs();
    var total = ROSTER_SLOTS.reduce(function (s, k) { return s + roster[k]; }, 0);
    fillSelect($("#cfg-rounds"), range(8, 22), Math.min(22, Math.max(8, total)));
  }

  function range(a, b) {
    var out = [];
    for (var i = a; i <= b; i++) out.push(i);
    return out;
  }

  function renderTeamNameInputs() {
    var n = parseInt($("#cfg-teams").value, 10);
    var wrap = $("#team-names");
    var prev = $$("#team-names input").map(function (el) { return el.value; });
    wrap.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Team " + (i + 1) + (i === parseInt($("#cfg-slot").value, 10) - 1 ? " (you)" : "");
      input.value = prev[i] || "";
      wrap.appendChild(input);
    }
  }

  function initSetup() {
    fillSelect($("#cfg-teams"), range(4, 16), 10);
    fillSelect($("#cfg-slot"), range(1, 10), 5);
    var grid = $("#roster-grid");
    grid.innerHTML = ROSTER_SLOTS.map(function (slot) {
      var label = slot === "DST" ? "DEF" : slot === "BN" ? "Bench" : slot;
      return (
        "<label>" + label +
        '<input type="number" id="roster-' + slot + '" min="0" max="8" value="' + DEFAULT_ROSTER[slot] + '"></label>'
      );
    }).join("");
    syncRoundsToRoster();
    renderTeamNameInputs();

    $("#cfg-teams").addEventListener("change", function () {
      var n = parseInt(this.value, 10);
      var slot = Math.min(parseInt($("#cfg-slot").value, 10), n);
      fillSelect($("#cfg-slot"), range(1, n), slot);
      renderTeamNameInputs();
    });
    $("#cfg-slot").addEventListener("change", renderTeamNameInputs);
    ROSTER_SLOTS.forEach(function (slot) {
      $("#roster-" + slot).addEventListener("change", syncRoundsToRoster);
    });

    $("#btn-start").addEventListener("click", startDraft);
    initKeeperSetup();

    var saved = loadSaved();
    if (saved && saved.config && saved.picks) {
      var btn = $("#btn-resume");
      btn.hidden = false;
      btn.textContent =
        "Resume Saved Draft (" + saved.picks.length + " picks, " + saved.config.teams + " teams)";
      btn.addEventListener("click", function () { resumeDraft(saved); });
    }

    reloadSetupData();
    $("#cfg-scoring").addEventListener("change", reloadSetupData);
  }

  function reloadSetupData() {
    loadData($("#cfg-scoring").value).then(function (d) {
      state.dataMeta = d;
      // Re-point existing keepers at the new dataset by name + position.
      var byKey = {};
      d.players.forEach(function (p) { byKey[p.name + "|" + p.pos] = p; });
      setupKeepers = setupKeepers.filter(function (k) {
        var p = byKey[k.name + "|" + k.pos];
        if (p) k.playerId = p.id;
        return !!p;
      });
      setupData = d;
      refreshKeeperControls();
      $("#data-note").textContent =
        d.players.length + " players loaded · " + d.season + " season · rankings " +
        "FantasyPros consensus · projections Sleeper · ADP FantasyFootballCalculator · updated " +
        d.updated.slice(0, 10);
    }).catch(function (err) {
      $("#data-note").textContent = "⚠ " + err.message + " — run `draft-optimizer update-data`";
    });
  }

  // ---------- keeper setup ----------

  function setupFormConfig() {
    return {
      scoring: $("#cfg-scoring").value,
      teams: parseInt($("#cfg-teams").value, 10),
      mySlot: parseInt($("#cfg-slot").value, 10) - 1,
      rounds: parseInt($("#cfg-rounds").value, 10),
      passTd6: $("#cfg-passtd").value === "6",
      roster: rosterFromInputs(),
    };
  }

  var setupPoolCache = { key: null, pool: null, byId: null };
  function setupPool() {
    if (!setupData) return null;
    var cfg = setupFormConfig();
    var key = cfg.scoring + "|" + cfg.teams + "|" + cfg.passTd6;
    if (setupPoolCache.key !== key) {
      var pool = E.buildPool(setupData.players, cfg);
      var byId = {};
      pool.forEach(function (p) { byId[p.id] = p; });
      setupPoolCache = { key: key, pool: pool, byId: byId };
    }
    return setupPoolCache;
  }

  function keeperOptionLabel(p) {
    return p.name + " (" + p.pos + (p.team ? " " + p.team : "") + ")";
  }

  function refreshKeeperControls() {
    var n = parseInt($("#cfg-teams").value, 10);
    var mySlot = parseInt($("#cfg-slot").value, 10) - 1;
    $("#keeper-team").innerHTML = range(0, n - 1)
      .map(function (i) {
        var names = $$("#team-names input");
        var nm = (names[i] && names[i].value.trim()) || "Team " + (i + 1);
        return "<option value='" + i + "'" + (i === mySlot ? " selected" : "") + ">" +
          esc(nm) + (i === mySlot ? " (you)" : "") + "</option>";
      })
      .join("");
    var rounds = parseInt($("#cfg-rounds").value, 10);
    $("#keeper-round").innerHTML = range(1, rounds)
      .map(function (r) { return "<option value='" + r + "'>Round " + r + "</option>"; })
      .join("");
    var sp = setupPool();
    if (sp) {
      $("#keeper-player-list").innerHTML = sp.pool
        .slice()
        .sort(function (a, b) { return a.rank - b.rank; })
        .slice(0, 400)
        .map(function (p) { return "<option value='" + esc(keeperOptionLabel(p)) + "'>"; })
        .join("");
    }
    // Drop keepers pointing at teams that no longer exist.
    setupKeepers = setupKeepers.filter(function (k) { return k.team < n && k.round <= rounds; });
    renderKeeperList();
  }

  function renderKeeperList() {
    var wrap = $("#keeper-list");
    var advice = $("#keeper-advice");
    var sp = setupPool();
    var cfg = setupFormConfig();
    wrap.innerHTML = setupKeepers
      .map(function (k, i) {
        var names = $$("#team-names input");
        var nm = (names[k.team] && names[k.team].value.trim()) || "Team " + (k.team + 1);
        var verdictHtml = "";
        if (sp && k.team === cfg.mySlot) {
          var p = sp.byId[k.playerId];
          if (p) {
            var ev = E.evaluateKeeper(sp.pool, cfg, p, k.round);
            var word = ev.verdict === "TOSS-UP" ? "TOSSUP" : ev.verdict;
            verdictHtml =
              "<span class='verdict " + word + "' title='" +
              esc(
                ev.surplus >= 0
                  ? "Worth ~" + ev.surplus + " pts more than drafting fresh at pick #" + ev.pickNumber +
                    (ev.alternative ? " (best likely alternative: " + ev.alternative.name + ")" : "")
                  : "Drafting fresh at pick #" + ev.pickNumber + " projects ~" + Math.abs(ev.surplus) +
                    " pts better" + (ev.alternative ? " (e.g. " + ev.alternative.name + ")" : "")
              ) +
              "'>" + ev.verdict + (ev.surplus >= 0 ? " +" : " ") + ev.surplus + "</span>";
          }
        }
        return (
          "<div class='keeper-row'><span class='who'>" + esc(nm) + "</span>" +
          "<span>" + esc(k.name) + " <span class='rd'>(" + k.pos + ")</span></span>" +
          "<span class='rd'>costs round " + k.round + "</span>" +
          verdictHtml +
          "<button class='rm' data-i='" + i + "' title='Remove'>✕</button></div>"
        );
      })
      .join("");
    $$("#keeper-list .rm").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setupKeepers.splice(parseInt(btn.getAttribute("data-i"), 10), 1);
        renderKeeperList();
      });
    });

    // Overall keep-0/1/2 advice for my team.
    var mine = setupKeepers.filter(function (k) { return k.team === cfg.mySlot; });
    if (!sp || !mine.length) {
      advice.textContent = mine.length
        ? ""
        : "Add your keeper candidates (and any rivals' keepers you know about) — you'll get a KEEP / PASS verdict for each of yours.";
      return;
    }
    var evaluated = mine
      .map(function (k) {
        var p = sp.byId[k.playerId];
        return p ? { k: k, ev: E.evaluateKeeper(sp.pool, cfg, p, k.round) } : null;
      })
      .filter(Boolean);
    var worth = evaluated.filter(function (x) { return x.ev.surplus > 0; });
    advice.textContent =
      worth.length === 0
        ? "Verdict: keep 0 — you project better drafting fresh in those rounds."
        : "Verdict: keep " + Math.min(2, worth.length) + " — " +
          worth
            .sort(function (a, b) { return b.ev.surplus - a.ev.surplus; })
            .slice(0, 2)
            .map(function (x) { return x.k.name + " (+" + x.ev.surplus + " pts)"; })
            .join(", ") + ". Remove the ones marked PASS before starting.";
  }

  function initKeeperSetup() {
    $("#keeper-add").addEventListener("click", function () {
      var sp = setupPool();
      if (!sp) return;
      var text = $("#keeper-player").value.trim();
      var player = sp.pool.find(function (p) {
        return keeperOptionLabel(p) === text || p.name.toLowerCase() === text.toLowerCase();
      });
      if (!player) { alert("Pick a player from the suggestions."); return; }
      var team = parseInt($("#keeper-team").value, 10);
      var round = parseInt($("#keeper-round").value, 10);
      if (setupKeepers.some(function (k) { return k.playerId === player.id; })) {
        alert(player.name + " is already a keeper."); return;
      }
      if (setupKeepers.filter(function (k) { return k.team === team; }).length >= 2) {
        alert("That team already has 2 keepers (league max)."); return;
      }
      if (setupKeepers.some(function (k) { return k.team === team && k.round === round; })) {
        alert("That team already has a keeper costing round " + round + "."); return;
      }
      setupKeepers.push({ team: team, playerId: player.id, name: player.name, pos: player.pos, round: round });
      $("#keeper-player").value = "";
      renderKeeperList();
    });
    ["cfg-teams", "cfg-slot", "cfg-rounds", "cfg-passtd"].forEach(function (id) {
      $("#" + id).addEventListener("change", refreshKeeperControls);
    });
    // Ranked cheat sheet, one row per player in board order. The first
    // column is the player name so the CSV drops straight into the Yahoo
    // pre-draft rankings import Chrome extension.
    $("#btn-rankings").addEventListener("click", function () {
      var sp = setupPool();
      if (!sp) { alert("Player data is still loading."); return; }
      var cfg = setupFormConfig();
      var lines = ["player,rank,position,nfl_team,bye,proj_points,vor,adp,tier"];
      sp.pool
        .slice()
        .sort(function (a, b) { return a.rank - b.rank; })
        .slice(0, 300)
        .forEach(function (p) {
          lines.push([
            csvCell(p.name), p.rank, p.pos === "DST" ? "DEF" : p.pos,
            p.team || "", p.bye || "", p.points != null ? p.points : "",
            p.vor != null ? p.vor : "",
            p.estAdp != null ? p.estAdp.toFixed(1) : "", p.tier || "",
          ].join(","));
        });
      downloadFile("rankings-" + cfg.scoring + "-" + new Date().toISOString().slice(0, 10) + ".csv",
        "text/csv", lines.join("\n") + "\n");
    });
  }

  function startDraft() {
    var teams = parseInt($("#cfg-teams").value, 10);
    var config = {
      scoring: $("#cfg-scoring").value,
      teams: teams,
      mySlot: parseInt($("#cfg-slot").value, 10) - 1,
      rounds: parseInt($("#cfg-rounds").value, 10),
      passTd6: $("#cfg-passtd").value === "6",
      roster: rosterFromInputs(),
      teamNames: $$("#team-names input").map(function (el, i) {
        return el.value.trim() || "Team " + (i + 1);
      }),
      keepers: setupKeepers.map(function (k) {
        return { team: k.team, playerId: k.playerId, round: k.round };
      }),
    };
    beginDraft(config, []);
  }

  function resumeDraft(saved) {
    beginDraft(saved.config, saved.picks);
  }

  function beginDraft(config, picks) {
    loadData(config.scoring).then(function (data) {
      state.config = config;
      state.picks = picks;
      state.pool = E.buildPool(data.players, config);
      state.poolById = {};
      state.pool.forEach(function (p) { state.poolById[p.id] = p; });
      // Drop keepers whose player id no longer resolves (e.g. stale save).
      config.keepers = (config.keepers || []).filter(function (k) {
        return state.poolById[k.playerId];
      });
      autoApplyKeepers();
      save();
      $("#setup-screen").hidden = true;
      $("#draft-screen").hidden = false;
      render();
      $("#search").focus();
    }).catch(function (err) {
      alert("Could not load player data: " + err.message);
    });
  }

  // ---------- picks ----------

  // When the draft reaches a pick that a keeper consumes, fill it in
  // automatically. Runs until the next open (human) pick.
  function autoApplyKeepers() {
    var applied = [];
    while (!draftOver()) {
      var pick = currentPick();
      var round = Math.floor(pick / state.config.teams) + 1;
      var team = onClock();
      var keeper = keepers().find(function (k) {
        return k.team === team && k.round === round && !draftedIds().has(k.playerId);
      });
      if (!keeper) break;
      state.picks.push({ playerId: keeper.playerId, team: team, auto: true });
      applied.push(keeper);
    }
    return applied;
  }

  function draftPlayer(playerId) {
    if (draftOver()) return;
    var player = state.poolById[playerId];
    if (!player || unavailableIds().has(playerId)) return;
    var team = onClock();
    state.picks.push({ playerId: playerId, team: team });
    var pickNo = state.picks.length;
    var auto = autoApplyKeepers();
    botAdvance();
    save();
    toast(
      "Pick " + pickNo + ": " + player.name + " → " + teamName(team) +
      (team === state.config.mySlot ? " (you)" : "") +
      (auto.length ? " · keeper pick" + (auto.length > 1 ? "s" : "") + " auto-filled" : "")
    );
    ui.search = "";
    $("#search").value = "";
    render();
  }

  function undo() {
    // Roll back keeper auto-fills and practice-bot picks, then one human pick.
    while (
      state.picks.length &&
      (state.picks[state.picks.length - 1].auto || state.picks[state.picks.length - 1].bot)
    )
      state.picks.pop();
    if (!state.picks.length) { render(); return; }
    var last = state.picks.pop();
    save();
    toast("Undid: " + state.poolById[last.playerId].name + " (was " + teamName(last.team) + ")");
    render();
  }

  // Practice mode: opponents draft themselves by market price (with light
  // positional sanity) until it's the user's turn.
  function botAdvance() {
    if (!$("#bot-toggle").checked) return;
    while (!draftOver() && !isMyTurn()) {
      var team = onClock();
      var round = Math.floor(currentPick() / state.config.teams) + 1;
      var lastTwo = state.config.rounds - 1;
      var mine = teamPlayers(team, true);
      var count = function (pos) { return mine.filter(function (p) { return p.pos === pos; }).length; };
      var blocked = unavailableIds();
      var best = null;
      state.pool.forEach(function (p) {
        if (blocked.has(p.id)) return;
        if ((p.pos === "K" || p.pos === "DST") && (round < lastTwo || count(p.pos) >= 1)) return;
        if (p.pos === "QB" && count("QB") >= 2) return;
        if (p.pos === "TE" && count("TE") >= 2) return;
        var price = (p.estAdp != null ? p.estAdp : p.rank + 15) + Math.random() * 3;
        if (!best || price < best.price) best = { p: p, price: price };
      });
      if (!best) break;
      state.picks.push({ playerId: best.p.id, team: team, bot: true });
      autoApplyKeepers();
    }
    save();
  }

  function renameTeam(t) {
    var name = prompt("Team name:", teamName(t));
    if (name && name.trim()) {
      state.config.teamNames = state.config.teamNames || [];
      state.config.teamNames[t] = name.trim();
      save();
      render();
    }
  }

  // Mid-draft keeper editor: fix a wrong round, remove a keeper, or add one
  // announced late. The board rebuilds around the change.
  function editKeepers() {
    var ks = keepers();
    var lines = ks.map(function (k, n) {
      var p = state.poolById[k.playerId];
      return (n + 1) + ". " + (p ? p.name : "?") + " — " + teamName(k.team) + ", costs round " + k.round;
    });
    var cmd = prompt(
      (lines.length ? lines.join("\n") : "No keepers configured.") +
      "\n\nCommands:\n  remove <n>\n  round <n> <newRound>\n  add",
      ""
    );
    if (!cmd || !cmd.trim()) return;
    var parts = cmd.trim().toLowerCase().split(/\s+/);
    var changed = false;
    if (parts[0] === "remove") {
      var ri = parseInt(parts[1], 10) - 1;
      if (isNaN(ri) || !ks[ri]) { alert("No keeper #" + parts[1]); return; }
      var gone = state.poolById[ks[ri].playerId];
      ks.splice(ri, 1);
      toast("Keeper removed: " + (gone ? gone.name : "?"));
      changed = true;
    } else if (parts[0] === "round") {
      var ki = parseInt(parts[1], 10) - 1;
      var newRound = parseInt(parts[2], 10);
      if (isNaN(ki) || !ks[ki]) { alert("No keeper #" + parts[1]); return; }
      if (isNaN(newRound) || newRound < 1 || newRound > state.config.rounds) {
        alert("Round must be 1-" + state.config.rounds); return;
      }
      var clash = ks.some(function (k, n) {
        return n !== ki && k.team === ks[ki].team && k.round === newRound;
      });
      if (clash) { alert("That team already has a keeper costing round " + newRound); return; }
      ks[ki].round = newRound;
      toast("Keeper now costs round " + newRound);
      changed = true;
    } else if (parts[0] === "add") {
      var player = promptForPlayer("Keeper player:");
      if (!player) return;
      var teamNo = parseInt(prompt("Which team? (1-" + state.config.teams + ")"), 10) - 1;
      if (isNaN(teamNo) || teamNo < 0 || teamNo >= state.config.teams) return;
      if (ks.filter(function (k) { return k.team === teamNo; }).length >= 2) {
        alert(teamName(teamNo) + " already has 2 keepers."); return;
      }
      var round = parseInt(prompt("Costs which round? (1-" + state.config.rounds + ")"), 10);
      if (isNaN(round) || round < 1 || round > state.config.rounds) return;
      if (ks.some(function (k) { return k.team === teamNo && k.round === round; })) {
        alert(teamName(teamNo) + " already has a keeper costing round " + round); return;
      }
      ks.push({ team: teamNo, playerId: player.id, round: round });
      toast("Keeper added: " + player.name + " → " + teamName(teamNo) + " (round " + round + ")");
      changed = true;
    } else {
      alert("Unknown command. Use: remove <n>, round <n> <newRound>, or add");
    }
    if (changed) {
      state.config.keepers = ks;
      rebuildFromHumans(humanPicks());
      save();
      render();
    }
  }

  // Prompt for an available player by name; returns the player or null.
  function promptForPlayer(message) {
    var query = prompt(message);
    if (!query || !query.trim()) return null;
    var q = query.trim().toLowerCase();
    var blocked = unavailableIds();
    var matches = state.pool.filter(function (p) {
      return !blocked.has(p.id) && p.name.toLowerCase().indexOf(q) !== -1;
    });
    if (!matches.length) {
      alert("No available player matches “" + query + "”.");
      return null;
    }
    matches.sort(function (a, b) { return a.rank - b.rank; });
    if (matches.length > 1 && matches[0].name.toLowerCase() !== q) {
      var pickText = matches.slice(0, 5).map(function (p, n) {
        return (n + 1) + ". " + p.name + " (" + p.pos + " " + (p.team || "") + ")";
      }).join("\n");
      var choice = prompt("Which one?\n" + pickText + "\n\nEnter a number:", "1");
      var idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= Math.min(5, matches.length)) return null;
      return matches[idx];
    }
    return matches[0];
  }

  // Human (non-keeper) picks in draft order.
  function humanPicks() {
    return state.picks.filter(function (pk) { return !pk.auto; });
  }

  // Rebuild the board from an ordered list of human picks: every pick's team
  // is re-derived from the snake order and keeper picks are re-seated at
  // their proper slots. This is what makes structural edits (delete a
  // mistaken pick, insert a missed one, change a keeper) safe mid-draft —
  // one fix can never leave the rest of the board misattributed.
  function rebuildFromHumans(humans) {
    var teams = state.config.teams;
    var keepersByIdx = {};
    keepers().forEach(function (k) {
      if (state.poolById[k.playerId]) {
        keepersByIdx[E.pickIndexFor(k.team, k.round, teams)] = k;
      }
    });
    var placed = [];
    var placedIds = new Set();
    var queue = humans.slice();
    for (var idx = 0; idx < totalPicks(); idx++) {
      var k = keepersByIdx[idx];
      if (k && !placedIds.has(k.playerId)) {
        placed.push({ playerId: k.playerId, team: E.teamOnClock(idx, teams), auto: true });
        placedIds.add(k.playerId);
        continue;
      }
      while (queue.length && placedIds.has(queue[0].playerId)) queue.shift();
      if (!queue.length) break;
      var pk = queue.shift();
      var entry = { playerId: pk.playerId, team: E.teamOnClock(idx, teams) };
      if (pk.bot) entry.bot = true;
      placed.push(entry);
      placedIds.add(pk.playerId);
    }
    if (queue.length) alert("Board is full — " + queue.length + " pick(s) could not be placed.");
    state.picks = placed;
  }

  // Swap the player on an already-entered pick (mis-clicks discovered a few
  // picks later) without unwinding everything after it.
  function fixPick(i) {
    var pk = state.picks[i];
    if (!pk || pk.auto) return;
    var old = state.poolById[pk.playerId];
    var player = promptForPlayer("Replace " + old.name + " (" + teamName(pk.team) + ") with:");
    if (!player) return;
    pk.playerId = player.id;
    save();
    toast("Pick " + (i + 1) + " corrected: " + old.name + " → " + player.name);
    render();
  }

  // Remove a pick that never happened; everything after it shifts up.
  function deletePick(i) {
    var pk = state.picks[i];
    if (!pk || pk.auto) return;
    var name = state.poolById[pk.playerId].name;
    if (!confirm("Delete pick " + (i + 1) + " (" + name + " → " + teamName(pk.team) + ")?\nEvery later pick shifts up one slot.")) return;
    var humans = humanPicks();
    humans.splice(humans.indexOf(pk), 1);
    rebuildFromHumans(humans);
    save();
    toast("Deleted: " + name + " — later picks renumbered");
    render();
  }

  // Insert a pick you missed recording; everything from there shifts down.
  function insertPick(i) {
    var player = promptForPlayer("Missed pick before #" + (i + 1) + " — who was taken?");
    if (!player) return;
    var humansBefore = state.picks.slice(0, i).filter(function (pk) { return !pk.auto; }).length;
    var humans = humanPicks();
    humans.splice(humansBefore, 0, { playerId: player.id });
    rebuildFromHumans(humans);
    save();
    toast("Inserted " + player.name + " — later picks renumbered");
    render();
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = "none"; }, 2600);
  }

  // ---------- rendering ----------

  function render() {
    renderClock();
    renderRecommendation();
    renderPool();
    renderTeams();
    if (draftOver() && !ui.recapShown) {
      ui.recapShown = true;
      showResults();
    }
  }

  function renderClock() {
    var cfg = state.config;
    var pick = currentPick();
    if (draftOver()) {
      $("#clock-pick").textContent = "Draft complete";
      $("#clock-team").textContent = "";
      $("#my-next").textContent = "";
      return;
    }
    var round = Math.floor(pick / cfg.teams) + 1;
    var inRound = (pick % cfg.teams) + 1;
    $("#clock-pick").textContent = "Round " + round + " · Pick " + inRound + " (#" + (pick + 1) + ")";
    $("#btn-recap").hidden = !state.picks.length;
    var clockEl = $("#clock-team");
    var team = onClock();
    clockEl.textContent = "On the clock: " + teamName(team) + (team === cfg.mySlot ? " — YOU" : "");
    clockEl.classList.toggle("me", team === cfg.mySlot);

    var myNext = E.nextPickForTeam(cfg.mySlot, pick, cfg.teams, totalPicks(), consumedSet());
    $("#my-next").textContent =
      myNext === null ? "You have no picks left" :
      myNext === pick ? "" :
      "Your next pick: #" + (myNext + 1) + " (" + (myNext - pick) + " picks away)";
    $("#btn-undo").disabled = !state.picks.length;
  }

  function recContext() {
    // When it's not my turn, plan ahead: evaluate the board as it stands from
    // the perspective of my next pick.
    var pick = currentPick();
    var cfg = state.config;
    var consumed = consumedSet();
    if (isMyTurn()) return { currentPick: pick, config: cfg, consumed: consumed };
    var myNext = E.nextPickForTeam(cfg.mySlot, pick, cfg.teams, totalPicks(), consumed);
    return myNext === null ? null : { currentPick: myNext, config: cfg, consumed: consumed };
  }

  function renderRecommendation() {
    var card = $("#rec-card");
    var alts = $("#rec-alts");
    var notesEl = $("#rec-notes");
    if (draftOver()) {
      card.className = "rec-card waiting";
      card.innerHTML =
        "<div class='rec-label'>DRAFT COMPLETE</div>" +
        "<div class='rec-meta'>Good luck this season!</div>" +
        "<button class='btn primary' id='btn-view-recap'>🏆 View recap &amp; grades</button>";
      $("#btn-view-recap").addEventListener("click", showResults);
      alts.innerHTML = "";
      notesEl.innerHTML = "";
      return;
    }
    var ctx = recContext();
    if (!ctx) {
      card.className = "rec-card waiting";
      card.innerHTML = "<div class='rec-label'>NO PICKS LEFT</div>";
      alts.innerHTML = "";
      notesEl.innerHTML = "";
      return;
    }
    var res = E.recommend(state.pool, unavailableIds(), teamPlayers(state.config.mySlot, true), ctx);
    var mine = isMyTurn();
    var top = res.recommendations[0];
    if (!top) {
      card.className = "rec-card waiting";
      card.innerHTML = "<div class='rec-label'>NO ELIGIBLE PLAYERS</div>";
      alts.innerHTML = "";
      notesEl.innerHTML = "";
      return;
    }
    var p = top.player;
    card.className = mine ? "rec-card" : "rec-card waiting";
    card.innerHTML =
      "<div class='rec-label'>" +
      (mine ? "▶ PICK NOW" : "PLAN — YOUR PICK #" + (ctx.currentPick + 1)) +
      "</div>" +
      "<div class='rec-player'>" + avatarHtml(p, 64) +
      "<div><div class='rec-name'>" + esc(p.name) + "</div>" +
      "<div class='rec-meta'><span class='pos-badge pos-" + p.pos + "'>" + (p.pos === "DST" ? "DEF" : p.pos) + "</span> " +
      esc(p.team || "") + " · bye " + (p.bye || "?") + " · " + p.points + " proj pts · ADP " +
      (p.estAdp ? p.estAdp.toFixed(1) : "—") + (p.injury ? " · <span class='inj'>" + esc(p.injury) + "</span>" : "") +
      "</div></div></div>" +
      "<ul class='rec-reasons'>" +
      top.reasons.slice(0, 4).map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") +
      "</ul>" +
      (mine
        ? "<button class='btn primary' id='btn-draft-rec'>Draft " + esc(p.name) + "</button>"
        : "<div class='rec-meta'>Waiting on " + esc(teamName(onClock())) + " — enter their pick from the list.</div>");
    if (mine) {
      $("#btn-draft-rec").addEventListener("click", function () { draftPlayer(p.id); });
    }

    alts.innerHTML =
      "<h4>NEXT BEST OPTIONS</h4>" +
      res.recommendations.slice(1, 6).map(function (r) {
        var q = r.player;
        return (
          "<div class='alt-row' data-id='" + q.id + "' title='" + esc(r.reasons.join(" · ")) + "'>" +
          "<span class='alt-score'>" + r.score.toFixed(0) + "</span>" +
          avatarHtml(q, 26) +
          "<span class='pos-badge pos-" + q.pos + "'>" + (q.pos === "DST" ? "DEF" : q.pos) + "</span>" +
          "<span class='alt-name'>" + esc(q.name) +
          " <span class='alt-sub'>" + esc(q.team || "") + " · ADP " + (q.estAdp ? q.estAdp.toFixed(0) : "—") + "</span></span>" +
          "</div>"
        );
      }).join("");
    $$(".alt-row").forEach(function (row) {
      row.addEventListener("click", function () {
        $("#search").value = "";
        ui.search = "";
        highlightId = row.getAttribute("data-id");
        renderPool();
      });
    });

    notesEl.innerHTML = res.notes
      .slice(0, 4)
      .map(function (n) { return "<div class='note'>" + esc(n) + "</div>"; })
      .join("");
  }

  var highlightId = null;

  function visiblePlayers() {
    var drafted = unavailableIds();
    var q = ui.search.trim().toLowerCase();
    return state.pool
      .filter(function (p) {
        if (!ui.showDrafted && drafted.has(p.id)) return false;
        if (ui.posFilter === "FLEX") {
          if (!(p.pos === "RB" || p.pos === "WR" || p.pos === "TE")) return false;
        } else if (ui.posFilter !== "ALL" && p.pos !== ui.posFilter) return false;
        if (q) {
          var hay = (p.name + " " + (p.team || "")).toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      })
      .sort(function (a, b) { return a.rank - b.rank; });
  }

  function renderPool() {
    var drafted = draftedIds();
    var pendingByPlayer = {};
    pendingKeepers().forEach(function (k) { pendingByPlayer[k.playerId] = k; });
    var rows = visiblePlayers().slice(0, 200);
    var over = draftOver();
    $("#pool-body").innerHTML = rows
      .map(function (p) {
        var keeper = pendingByPlayer[p.id];
        var isDrafted = drafted.has(p.id) || !!keeper;
        var cls = (isDrafted ? "drafted" : "") + (p.id === highlightId ? " highlight" : "");
        return (
          "<tr class='" + cls + "' data-id='" + p.id + "'>" +
          "<td>" + (isDrafted || over ? "" : "<button class='pick-btn' data-id='" + p.id + "'>Draft</button>") + "</td>" +
          "<td>" + p.rank + "</td>" +
          "<td><span class='pcell'>" + avatarHtml(p, 26) +
          "<span class='pname'>" + esc(p.name) + "</span><span class='pteam'>" + esc(p.team || "") + "</span>" +
          (keeper ? "<span class='keeper-tag' title='Keeper — costs " + esc(teamName(keeper.team)) +
            "’s round-" + keeper.round + " pick'>KEPT</span>" : "") +
          (p.injury ? "<span class='inj'>" + esc(p.injury.slice(0, 3)) + "</span>" : "") + "</span></td>" +
          "<td><span class='pos-badge pos-" + p.pos + "'>" + (p.pos === "DST" ? "DEF" : p.pos) + "</span></td>" +
          "<td>" + (p.bye || "—") + "</td>" +
          "<td>" + (p.points != null ? p.points.toFixed(0) + (p.pointsEstimated ? "*" : "") : "—") + "</td>" +
          "<td>" + (p.vor != null ? p.vor.toFixed(0) : "—") + "</td>" +
          "<td>" + (p.estAdp != null ? p.estAdp.toFixed(1) : "—") + "</td>" +
          "<td>" + (p.tier || "—") + "</td>" +
          "</tr>"
        );
      })
      .join("");
    $$(".pick-btn").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        draftPlayer(btn.getAttribute("data-id"));
      });
    });
  }

  function starterAssignment(players, roster) {
    // Greedy: fill dedicated slots by best points, then FLEX, then bench.
    var slots = [];
    ["QB", "RB", "WR", "TE", "FLEX", "K", "DST"].forEach(function (s) {
      for (var i = 0; i < (roster[s] || 0); i++) slots.push({ slot: s, player: null });
    });
    var sorted = players.slice().sort(function (a, b) { return b.points - a.points; });
    var bench = [];
    sorted.forEach(function (p) {
      var direct = slots.find(function (s) { return s.slot === p.pos && !s.player; });
      if (direct) { direct.player = p; return; }
      if (p.pos === "RB" || p.pos === "WR" || p.pos === "TE") {
        var flex = slots.find(function (s) { return s.slot === "FLEX" && !s.player; });
        if (flex) { flex.player = p; return; }
      }
      bench.push(p);
    });
    return { slots: slots, bench: bench };
  }

  function renderTeams() {
    var cfg = state.config;
    $("#teams-panel").hidden = ui.teamsTab !== "rosters";
    $("#log-panel").hidden = ui.teamsTab !== "log";
    $("#tab-rosters").classList.toggle("active", ui.teamsTab === "rosters");
    $("#tab-log").classList.toggle("active", ui.teamsTab === "log");

    if (ui.teamsTab === "log") {
      $("#log-panel").innerHTML = state.picks
        .map(function (pk, i) {
          var p = state.poolById[pk.playerId];
          var round = Math.floor(i / cfg.teams) + 1;
          var inRound = (i % cfg.teams) + 1;
          return (
            "<div class='log-item'><span class='log-pick'>" + round + "." +
            (inRound < 10 ? "0" : "") + inRound + "</span>" +
            "<span class='pos-badge pos-" + p.pos + "'>" + (p.pos === "DST" ? "DEF" : p.pos) + "</span> " +
            "<span>" + esc(p.name) + (pk.auto ? "<span class='keeper-tag'>KEEPER</span>" : "") + "</span>" +
            "<span class='log-team'>" + esc(teamName(pk.team)) + "</span>" +
            "<button class='rm log-ins' data-i='" + i + "' title='Insert a missed pick before this one'>＋</button>" +
            (pk.auto ? "" :
              "<button class='rm log-edit' data-i='" + i + "' title='Entered the wrong player? Swap this pick'>✎</button>" +
              "<button class='rm log-del' data-i='" + i + "' title='Delete this pick (later picks shift up)'>✕</button>") +
            "</div>"
          );
        })
        .reverse()
        .join("") || "<div class='note'>No picks yet.</div>";
      $$(".log-edit").forEach(function (btn) {
        btn.addEventListener("click", function () {
          fixPick(parseInt(btn.getAttribute("data-i"), 10));
        });
      });
      $$(".log-del").forEach(function (btn) {
        btn.addEventListener("click", function () {
          deletePick(parseInt(btn.getAttribute("data-i"), 10));
        });
      });
      $$(".log-ins").forEach(function (btn) {
        btn.addEventListener("click", function () {
          insertPick(parseInt(btn.getAttribute("data-i"), 10));
        });
      });
      return;
    }

    var clock = draftOver() ? -1 : onClock();
    var pendingIds = new Set();
    pendingKeepers().forEach(function (k) { pendingIds.add(k.playerId); });
    $("#teams-panel").innerHTML = range(0, cfg.teams - 1)
      .map(function (t) {
        var players = teamPlayers(t, true);
        var isMe = t === cfg.mySlot;
        var open = isMe || ui.openTeams[t];
        var head =
          "<div class='team-head' data-team='" + t + "' title='Click to expand · double-click to rename'>" +
          "<span>" + esc(teamName(t)) + (isMe ? " ⭐" : "") +
          " <button class='rm head-rename' data-team='" + t + "' title='Rename team'>✎</button></span>" +
          "<span class='badge'>" + players.length + " picks " + (open ? "▾" : "▸") + "</span></div>";
        if (!open) {
          return "<div class='team-card" + (isMe ? " me" : "") + (t === clock ? " on-clock" : "") + "'>" + head + "</div>";
        }
        var asg = starterAssignment(players, cfg.roster);
        var myByes = {};
        players.forEach(function (p) {
          if (p.bye != null) myByes[p.pos + "-" + p.bye] = (myByes[p.pos + "-" + p.bye] || 0) + 1;
        });
        var body =
          "<div class='team-body'>" +
          asg.slots.map(function (s) {
            var label = s.slot === "DST" ? "DEF" : s.slot;
            if (!s.player) {
              return "<div class='slot-row'><span class='slot-label'>" + label + "</span><span class='empty-slot'>—</span></div>";
            }
            var clash = s.player.bye != null && myByes[s.player.pos + "-" + s.player.bye] > 1;
            return (
              "<div class='slot-row'><span class='slot-label'>" + label + "</span>" +
              "<span>" + esc(s.player.name) +
              (pendingIds.has(s.player.id) ? "<span class='keeper-tag'>K</span>" : "") + "</span>" +
              "<span class='slot-bye" + (clash ? " bye-clash" : "") + "'>bye " + (s.player.bye || "?") + (clash ? " ⚠" : "") + "</span></div>"
            );
          }).join("") +
          (asg.bench.length
            ? "<div class='slot-row'><span class='slot-label'>BN</span><span>" +
              asg.bench.map(function (p) {
                return esc(p.name) + (pendingIds.has(p.id) ? "<span class='keeper-tag'>K</span>" : "");
              }).join(", ") + "</span></div>"
            : "") +
          "</div>";
        return "<div class='team-card" + (isMe ? " me" : "") + (t === clock ? " on-clock" : "") + "'>" + head + body + "</div>";
      })
      .join("");
    $$(".team-head").forEach(function (el) {
      el.addEventListener("click", function () {
        var t = parseInt(el.getAttribute("data-team"), 10);
        ui.openTeams[t] = !ui.openTeams[t];
        renderTeams();
      });
      el.addEventListener("dblclick", function () {
        renameTeam(parseInt(el.getAttribute("data-team"), 10));
      });
    });
    $$(".head-rename").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        renameTeam(parseInt(btn.getAttribute("data-team"), 10));
      });
    });
  }

  // ---------- recap ----------

  function shortName(p) {
    if (p.pos === "DST") return p.name.split(" ").pop() + " D/ST";
    var parts = p.name.split(" ");
    return parts.length > 1 ? parts[0][0] + ". " + parts.slice(1).join(" ") : p.name;
  }

  function showResults() {
    var cfg = state.config;
    var autoIdx = new Set();
    var teamsPicks = range(0, cfg.teams - 1).map(function () { return []; });
    state.picks.forEach(function (pk, i) {
      if (pk.auto) autoIdx.add(i);
      teamsPicks[pk.team].push({ player: state.poolById[pk.playerId], pickNumber: i + 1, auto: !!pk.auto });
    });
    var rows = E.evaluateTeams(teamsPicks, cfg);
    var order = range(0, cfg.teams - 1).sort(function (a, b) { return rows[b].quality - rows[a].quality; });
    var maxPts = Math.max.apply(null, rows.map(function (r) { return r.starterPts; })) || 1;

    $("#recap-sub").textContent =
      cfg.teams + " teams · " + state.picks.length + " picks · projected points from your starters decide the grade";

    var fact = function (label, x) {
      if (!x) return "<span class='pickfact'>" + label + ": —</span>";
      var d = Math.round(x.delta);
      return (
        "<span class='pickfact'>" + label + ": <b>" + esc(shortName(x.pick.player)) + "</b> " +
        "<span class='" + (d >= 0 ? "delta-pos" : "delta-neg") + "'>" + (d >= 0 ? "+" : "") + d + "</span>" +
        " <span title='picked #" + x.pick.pickNumber + ", ADP " + x.pick.player.estAdp.toFixed(0) + "'>vs ADP</span></span>"
      );
    };

    $("#grades-table").innerHTML =
      "<div class='grade-row head'><span>RANK</span><span>GRADE</span><span>TEAM</span><span>PROJ STARTER PTS</span><span style='text-align:right'>BENCH</span><span>BEST VALUE</span><span>BIGGEST REACH</span></div>" +
      order.map(function (t, i) {
        var r = rows[t];
        var isMe = t === cfg.mySlot;
        return (
          "<div class='grade-row" + (isMe ? " me" : "") + "'>" +
          "<span>#" + (i + 1) + "</span>" +
          "<span class='grade-chip grade-" + r.grade + "'>" + r.grade + "</span>" +
          "<span class='grade-team'>" + esc(teamName(t)) + (isMe ? " ⭐" : "") +
          "<span class='sub'>" + teamsPicks[t].length + " picks</span></span>" +
          "<span class='ptsbar'><span class='bar'><span class='fill' style='width:" +
          Math.round((r.starterPts / maxPts) * 100) + "%'></span></span><span class='num'>" + r.starterPts + "</span></span>" +
          "<span class='grade-bench'>" + r.benchPts + "</span>" +
          fact("Steal", r.steal) + fact("Reach", r.reach) +
          "</div>"
        );
      }).join("");

    // Pick-by-pick board: rounds down the side, teams across the top.
    var roundsDone = Math.ceil(state.picks.length / cfg.teams);
    var head =
      "<tr><th></th>" +
      range(0, cfg.teams - 1).map(function (t) {
        return "<th" + (t === cfg.mySlot ? " class='me-col'" : "") + ">" + esc(teamName(t)) + "</th>";
      }).join("") + "</tr>";
    var body = range(1, roundsDone).map(function (rd) {
      return (
        "<tr><td class='rd-cell'>" + rd + "</td>" +
        range(0, cfg.teams - 1).map(function (t) {
          var idx = E.pickIndexFor(t, rd, cfg.teams);
          var pk = state.picks[idx];
          var me = t === cfg.mySlot ? " me-col" : "";
          if (!pk) return "<td class='" + me + "'></td>";
          var p = state.poolById[pk.playerId];
          var d = p.estAdp != null ? Math.round(p.estAdp - (idx + 1)) : null;
          return (
            "<td class='" + me + "'><div class='cell c-" + p.pos + "' title='" +
            esc(p.name + " — pick #" + (idx + 1) + (p.estAdp != null ? ", ADP " + p.estAdp.toFixed(0) : "")) + "'>" +
            "<span class='nm'>" + esc(shortName(p)) + (pk.auto ? "<span class='keeper-tag'>K</span>" : "") + "</span>" +
            "<span class='in'><span>" + (p.pos === "DST" ? "DEF" : p.pos) + " · " + Math.round(p.points) + "</span>" +
            (d == null ? "<span></span>" :
              "<span class='" + (d >= 0 ? "delta-pos" : "delta-neg") + "'>" + (d >= 0 ? "+" : "") + d + "</span>") +
            "</span></div></td>"
          );
        }).join("") + "</tr>"
      );
    }).join("");
    $("#draft-board").innerHTML = head + body;

    $("#draft-screen").hidden = true;
    $("#results-screen").hidden = false;
    window.scrollTo(0, 0);
  }

  function hideResults() {
    $("#results-screen").hidden = true;
    $("#draft-screen").hidden = false;
  }

  // ---------- export ----------

  function downloadFile(name, mime, content) {
    var blob = new Blob([content], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // Pick-by-pick CSV in draft order — matches the order Yahoo's commissioner
  // "enter offline draft results" flow walks through, so it doubles as the
  // entry sheet for getting results into Yahoo after an offline draft.
  function exportCsv() {
    var cfg = state.config;
    var header = ["overall", "round", "pick_in_round", "fantasy_team", "player",
      "position", "nfl_team", "bye", "proj_points", "adp", "keeper"];
    var lines = [header.join(",")];
    state.picks.forEach(function (pk, i) {
      var p = state.poolById[pk.playerId];
      lines.push([
        i + 1,
        Math.floor(i / cfg.teams) + 1,
        (i % cfg.teams) + 1,
        csvCell(teamName(pk.team)),
        csvCell(p.name),
        p.pos === "DST" ? "DEF" : p.pos,
        p.team || "",
        p.bye || "",
        p.points != null ? p.points : "",
        p.estAdp != null ? p.estAdp.toFixed(1) : "",
        pk.auto ? "Y" : "",
      ].join(","));
    });
    downloadFile("draft-" + new Date().toISOString().slice(0, 10) + ".csv",
      "text/csv", lines.join("\n") + "\n");
  }

  // Team-by-team roster sheet in the same order Yahoo's commissioner
  // "Submit Draft Results" flow asks for players (it fills each team's
  // roster in turn — it does NOT replay pick-by-pick).
  function exportYahooSheet() {
    var cfg = state.config;
    var lines = ["fantasy_team,entry_order,player,position,nfl_team,round_drafted,keeper"];
    range(0, cfg.teams - 1).forEach(function (t) {
      var n = 0;
      state.picks.forEach(function (pk, i) {
        if (pk.team !== t) return;
        var p = state.poolById[pk.playerId];
        n += 1;
        lines.push([
          csvCell(teamName(t)), n, csvCell(p.name),
          p.pos === "DST" ? "DEF" : p.pos, p.team || "",
          Math.floor(i / cfg.teams) + 1, pk.auto ? "Y" : "",
        ].join(","));
      });
    });
    downloadFile("yahoo-entry-sheet-" + new Date().toISOString().slice(0, 10) + ".csv",
      "text/csv", lines.join("\n") + "\n");
  }

  function exportDraft() {
    var cfg = state.config;
    var out = {
      exported: new Date().toISOString(),
      config: cfg,
      picks: state.picks.map(function (pk, i) {
        var p = state.poolById[pk.playerId];
        return {
          overall: i + 1,
          round: Math.floor(i / cfg.teams) + 1,
          team: teamName(pk.team),
          player: p.name,
          pos: p.pos,
          nflTeam: p.team,
          bye: p.bye,
          projPoints: p.points,
        };
      }),
    };
    downloadFile("draft-" + new Date().toISOString().slice(0, 10) + ".json",
      "application/json", JSON.stringify(out, null, 2));
  }

  // ---------- events ----------

  function initDraftEvents() {
    $("#btn-undo").addEventListener("click", undo);
    $("#btn-export").addEventListener("click", exportDraft);
    $("#btn-recap").addEventListener("click", showResults);
    $("#btn-keepers").addEventListener("click", editKeepers);
    $("#btn-back").addEventListener("click", hideResults);
    $("#btn-export2").addEventListener("click", exportDraft);
    $("#btn-csv").addEventListener("click", exportCsv);
    $("#btn-yahoo").addEventListener("click", exportYahooSheet);
    $("#btn-restart").addEventListener("click", function () {
      if (confirm("Abandon this draft and return to setup? (The saved draft will be cleared.)")) {
        clearSaved();
        location.reload();
      }
    });
    $("#search").addEventListener("input", function () {
      ui.search = this.value;
      highlightId = null;
      renderPool();
    });
    $("#search").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        var blocked = unavailableIds();
        var first = visiblePlayers().filter(function (p) { return !blocked.has(p.id); })[0];
        if (first) draftPlayer(first.id);
      }
    });
    $$("#pos-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $$("#pos-tabs button").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        ui.posFilter = btn.getAttribute("data-pos");
        renderPool();
      });
    });
    $("#show-drafted").addEventListener("change", function () {
      ui.showDrafted = this.checked;
      renderPool();
    });
    $("#tab-rosters").addEventListener("click", function () { ui.teamsTab = "rosters"; renderTeams(); });
    $("#tab-log").addEventListener("click", function () { ui.teamsTab = "log"; renderTeams(); });
    $("#bot-toggle").addEventListener("change", function () {
      botAdvance();
      render();
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "/" && document.activeElement !== $("#search")) {
        ev.preventDefault();
        $("#search").focus();
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "z") {
        ev.preventDefault();
        undo();
      }
    });
  }

  // ---------- boot ----------

  document.addEventListener("DOMContentLoaded", function () {
    initSetup();
    initDraftEvents();
  });
})();
