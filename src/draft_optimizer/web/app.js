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
      roster: rosterFromInputs(),
    };
  }

  var setupPoolCache = { key: null, pool: null, byId: null };
  function setupPool() {
    if (!setupData) return null;
    var cfg = setupFormConfig();
    var key = cfg.scoring + "|" + cfg.teams;
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
    ["cfg-teams", "cfg-slot", "cfg-rounds"].forEach(function (id) {
      $("#" + id).addEventListener("change", refreshKeeperControls);
    });
  }

  function startDraft() {
    var teams = parseInt($("#cfg-teams").value, 10);
    var config = {
      scoring: $("#cfg-scoring").value,
      teams: teams,
      mySlot: parseInt($("#cfg-slot").value, 10) - 1,
      rounds: parseInt($("#cfg-rounds").value, 10),
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
    // Roll back any auto-filled keeper picks, then one human pick.
    while (state.picks.length && state.picks[state.picks.length - 1].auto) state.picks.pop();
    if (!state.picks.length) { render(); return; }
    var last = state.picks.pop();
    save();
    toast("Undid: " + state.poolById[last.playerId].name + " (was " + teamName(last.team) + ")");
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
      "<div class='rec-name'>" + esc(p.name) + "</div>" +
      "<div class='rec-meta'><span class='pos-badge pos-" + p.pos + "'>" + (p.pos === "DST" ? "DEF" : p.pos) + "</span> " +
      esc(p.team || "") + " · bye " + (p.bye || "?") + " · " + p.points + " proj pts · ADP " +
      (p.estAdp ? p.estAdp.toFixed(1) : "—") + (p.injury ? " · <span class='inj'>" + esc(p.injury) + "</span>" : "") +
      "</div>" +
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
          "<td><span class='pname'>" + esc(p.name) + "</span><span class='pteam'>" + esc(p.team || "") + "</span>" +
          (keeper ? "<span class='keeper-tag' title='Keeper — costs " + esc(teamName(keeper.team)) +
            "’s round-" + keeper.round + " pick'>KEPT</span>" : "") +
          (p.injury ? "<span class='inj'>" + esc(p.injury.slice(0, 3)) + "</span>" : "") + "</td>" +
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
            "<span class='log-team'>" + esc(teamName(pk.team)) + "</span></div>"
          );
        })
        .reverse()
        .join("") || "<div class='note'>No picks yet.</div>";
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
          "<div class='team-head' data-team='" + t + "'>" +
          "<span>" + esc(teamName(t)) + (isMe ? " ⭐" : "") + "</span>" +
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
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "draft-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- events ----------

  function initDraftEvents() {
    $("#btn-undo").addEventListener("click", undo);
    $("#btn-export").addEventListener("click", exportDraft);
    $("#btn-recap").addEventListener("click", showResults);
    $("#btn-back").addEventListener("click", hideResults);
    $("#btn-export2").addEventListener("click", exportDraft);
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
