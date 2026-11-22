/**
 * ctrlyoke CLA intake (Google Apps Script, bound to the private "ctrlyoke CLA acceptances"
 * Sheet in Fuzzy Nova's Workspace). Setup and operation: legal/cla-intake/README.md.
 *
 * Every five minutes it:
 *   1. reads new CLA acceptance emails sent to licensing@, checks them against GitHub, and
 *      records each one in the Sheet;
 *   2. re-checks recorded acceptances still waiting for the contributor's PR comment;
 *   3. sets the `cla` commit status on every open PR, and posts the acceptance request
 *      (with a pre-filled email link) for anyone who has not accepted yet.
 *
 * Contributors are recognized by GitHub user ID, so an accepted contributor's later PRs
 * pass without asking again. Email addresses and entity names stay in the Sheet; GitHub
 * only ever receives usernames, which the PR already shows.
 */

const CONFIG = {
  owner: "FuzzyNova",
  repo: "ctrlyoke",
  claVersion: "1.0",
  statusContext: "cla",
  mailbox: "licensing@ctrlyoke.dev",
  emailSubject: "ctrlyoke CLA acceptance",
  /** Accounts that never need to accept (the maintainer and Dependabot). Lowercase. */
  exemptLogins: ["nhickster", "dependabot[bot]"],
  sheetName: "Acceptances",
  labelRecorded: "CLA/recorded",
  labelReview: "CLA/needs-review",
  /**
   * PR label a maintainer adds after checking a case the script can't, such as commits not
   * linked to a GitHub account. Only people with triage access can add labels.
   */
  overrideLabel: "cla-verified",
  /** Email the script owner when an acceptance needs a person to look at it. */
  notifyOnReview: true,
  claUrl: "https://ctrlyoke.dev/cla/1.0/",
  privacyUrl:
    "https://ctrlyoke.dev/privacy/#36-contributions-and-contributor-license-agreement-records",
  contributingUrl:
    "https://github.com/FuzzyNova/ctrlyoke/blob/main/CONTRIBUTING.md#submitting-a-change",
};

const STATUS = {
  accepted: "accepted",
  awaitingConfirmation: "awaiting-confirmation",
  needsReview: "needs-review",
  rejected: "rejected",
};

const COLUMNS = [
  "Received",
  "GitHub login",
  "GitHub user ID",
  "CLA version",
  "PR URL",
  "Sender email",
  "Entity",
  "Status",
  "Note",
  "Email thread",
  "Confirmation comment",
  "Updated",
];
const COL = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));

const REQUEST_MARKER = "ctrlyoke-cla-request";

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/** Run once by hand: creates the Sheet headers, Gmail labels and the 5-minute trigger. */
function setup() {
  githubToken_(); // fail early if the token is missing
  const sheet = acceptanceSheet_();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.values(STATUS), true)
    .build();
  sheet
    .getRange(2, COL["Status"] + 1, sheet.getMaxRows() - 1, 1)
    .setDataValidation(statusRule);

  [CONFIG.labelRecorded, CONFIG.labelReview].forEach(
    (name) => GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name)
  );

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "runClaIntake")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("runClaIntake").timeBased().everyMinutes(5).create();
}

/** Trigger handler. Safe to run by hand. */
function runClaIntake() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    processNewEmails_();
    recheckAwaitingConfirmation_();
    updateOpenPullRequests_();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------------------
// 1. Acceptance emails
// ---------------------------------------------------------------------------------------

function processNewEmails_() {
  const query =
    `{to:${CONFIG.mailbox} deliveredto:${CONFIG.mailbox}} ` +
    `"Contributor License Agreement" ` +
    `-label:${CONFIG.labelRecorded.replace("/", "-")} ` +
    `-label:${CONFIG.labelReview.replace("/", "-")} newer_than:180d`;
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const recorded = GmailApp.getUserLabelByName(CONFIG.labelRecorded);
  const review = GmailApp.getUserLabelByName(CONFIG.labelReview);

  GmailApp.search(query, 0, 50).forEach((thread) => {
    const message = thread
      .getMessages()
      .find((m) => senderAddress_(m.getFrom()) !== me);
    if (!message) return;
    try {
      const row = evaluateAcceptance_(message, thread);
      appendRow_(row);
      thread.addLabel(
        row[COL["Status"]] === STATUS.needsReview ? review : recorded
      );
      if (row[COL["Status"]] === STATUS.needsReview) notifyReview_(row);
    } catch (err) {
      console.error(
        `CLA email ${thread.getId()}: ${err && err.stack ? err.stack : err}`
      );
    }
  });
}

/** Builds the Sheet row for one acceptance email. Never throws for bad input. */
function evaluateAcceptance_(message, thread) {
  const body = message.getPlainBody() || "";
  const parsed = parseAcceptance_(body);
  const row = new Array(COLUMNS.length).fill("");
  row[COL["Received"]] = message.getDate();
  row[COL["Sender email"]] = senderAddress_(message.getFrom());
  row[COL["Email thread"]] = thread.getPermalink();
  row[COL["Updated"]] = new Date();
  row[COL["GitHub login"]] = parsed.login || "";
  row[COL["CLA version"]] = parsed.version || "";
  row[COL["PR URL"]] = parsed.prUrl || "";
  row[COL["Entity"]] = parsed.entity || "";

  const review = (note) => {
    row[COL["Status"]] = STATUS.needsReview;
    row[COL["Note"]] = note;
    return row;
  };

  if (!parsed.accepts)
    return review("No acceptance statement found in the email.");
  if (!parsed.login) return review("No GitHub username found in the email.");
  if (!parsed.prNumber)
    return review("No ctrlyoke pull request link found in the email.");
  if (parsed.version !== CONFIG.claVersion) {
    return review(
      `Accepts CLA v${parsed.version || "?"}, current is v${CONFIG.claVersion}.`
    );
  }

  const user = github_("get", `/users/${encodeURIComponent(parsed.login)}`);
  if (!user) return review(`GitHub user @${parsed.login} does not exist.`);
  row[COL["GitHub login"]] = user.login;
  row[COL["GitHub user ID"]] = user.id;

  const pr = github_("get", repoPath_(`/pulls/${parsed.prNumber}`));
  if (!pr) return review(`Pull request #${parsed.prNumber} does not exist.`);
  const contributors = pullRequestContributors_(pr);
  if (!contributors.known.some((c) => c.id === user.id)) {
    return review(
      `@${user.login} is not the author or a commit author of PR #${pr.number}.`
    );
  }

  if (parsed.entity) {
    return review(
      "Entity acceptance: check the signer's authority, then set Status to accepted."
    );
  }
  if (!senderAuthenticated_(message)) {
    return review(
      "The email did not pass DMARC, or DKIM and SPF. Check the sender."
    );
  }

  const comment = findConfirmationComment_(pr.number, user.id);
  if (comment) {
    row[COL["Status"]] = STATUS.accepted;
    row[COL["Confirmation comment"]] = comment.html_url;
  } else {
    row[COL["Status"]] = STATUS.awaitingConfirmation;
    row[COL["Note"]] = "Waiting for the contributor to confirm on the PR.";
  }
  return row;
}

function parseAcceptance_(body) {
  const text = body.replace(/\r/g, "");
  const version = text.match(/Contributor License Agreement\s+v?(\d+\.\d+)/i);
  const pr = text.match(
    new RegExp(
      `https://github\\.com/${CONFIG.owner}/${CONFIG.repo}/pull/(\\d+)`,
      "i"
    )
  );
  const login = text.match(
    /GitHub username is\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/i
  );
  const entity = text.match(
    /authori[sz]ed to sign the ctrlyoke Contributor License Agreement on behalf of\s+(.+?)(?:\.\s|\.$|\n|$)/im
  );
  return {
    accepts: /\bI accept the ctrlyoke Contributor License Agreement\b/i.test(
      text
    ),
    version: version ? version[1] : null,
    prNumber: pr ? Number(pr[1]) : null,
    prUrl: pr ? pr[0] : null,
    login: login ? login[1] : null,
    entity: entity ? entity[1].trim() : null,
  };
}

/**
 * Gmail's own Authentication-Results header. Gmail adds it above every header the sender
 * wrote, so only the topmost one is trusted; a sender can forge any header below it.
 */
function senderAuthenticated_(message) {
  const raw = message.getRawContent();
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headers = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).replace(
    /\r?\n[ \t]+/g,
    " "
  );
  const topmost = headers
    .split(/\r?\n/)
    .find((line) => /^Authentication-Results:/i.test(line));
  if (
    !topmost ||
    !/^Authentication-Results:\s*mx\.google\.com\b/i.test(topmost)
  )
    return false;
  const results = topmost;
  if (/\bdmarc=pass\b/i.test(results)) return true;
  return /\bdkim=pass\b/i.test(results) && /\bspf=pass\b/i.test(results);
}

// ---------------------------------------------------------------------------------------
// 2. Acceptances waiting for the PR comment
// ---------------------------------------------------------------------------------------

function recheckAwaitingConfirmation_() {
  const sheet = acceptanceSheet_();
  const rows = dataRows_(sheet);
  rows.forEach((row, i) => {
    if (row[COL["Status"]] !== STATUS.awaitingConfirmation) return;
    const prNumber = prNumberFromUrl_(row[COL["PR URL"]]);
    const userId = Number(row[COL["GitHub user ID"]]);
    if (!prNumber || !userId) return;
    try {
      const comment = findConfirmationComment_(prNumber, userId);
      if (!comment) return;
      const r = i + 2;
      sheet.getRange(r, COL["Status"] + 1).setValue(STATUS.accepted);
      sheet.getRange(r, COL["Note"] + 1).setValue("");
      sheet
        .getRange(r, COL["Confirmation comment"] + 1)
        .setValue(comment.html_url);
      sheet.getRange(r, COL["Updated"] + 1).setValue(new Date());
    } catch (err) {
      console.error(
        `Recheck row ${i + 2}: ${err && err.stack ? err.stack : err}`
      );
    }
  });
}

/** Any comment by that user on the PR, other than the script's own request. */
function findConfirmationComment_(prNumber, userId) {
  const comments = githubAll_(repoPath_(`/issues/${prNumber}/comments`));
  return (
    comments.find(
      (c) => c.user && c.user.id === userId && !c.body.includes(REQUEST_MARKER)
    ) || null
  );
}

// ---------------------------------------------------------------------------------------
// 3. Open pull requests
// ---------------------------------------------------------------------------------------

function updateOpenPullRequests_() {
  const accepted = acceptedUserIds_();
  githubAll_(repoPath_("/pulls?state=open")).forEach((pr) => {
    try {
      updatePullRequest_(pr, accepted);
    } catch (err) {
      console.error(`PR #${pr.number}: ${err && err.stack ? err.stack : err}`);
    }
  });
}

function updatePullRequest_(pr, accepted) {
  const contributors = pullRequestContributors_(pr);
  const missing = contributors.known.filter(
    (c) => !isExempt_(c.login) && !accepted.has(c.id)
  );

  const verifiedByMaintainer = (pr.labels || []).some(
    (l) => l.name === CONFIG.overrideLabel
  );

  let state;
  let description;
  if (verifiedByMaintainer) {
    setCommitStatus_(pr.head.sha, "success", "CLA verified by a maintainer.");
    return;
  }
  if (missing.length === 0 && contributors.unlinked === 0) {
    state = "success";
    description = "All contributors have accepted the CLA.";
  } else {
    state = "pending";
    const parts = [];
    if (missing.length)
      parts.push(`Waiting for ${missing.map((c) => "@" + c.login).join(", ")}`);
    if (contributors.unlinked) {
      parts.push(
        `${contributors.unlinked} commit(s) not linked to a GitHub account`
      );
    }
    description = parts.join("; ");
  }
  setCommitStatus_(pr.head.sha, state, description.slice(0, 140));
  if (missing.length) requestAcceptance_(pr, missing);
}

/**
 * The PR author plus every commit author. Commits whose author email is not linked to a
 * GitHub account cannot be checked automatically, so they are counted as `unlinked`.
 */
function pullRequestContributors_(pr) {
  const byId = new Map();
  const add = (user) => {
    if (user && !byId.has(user.id))
      byId.set(user.id, { id: user.id, login: user.login });
  };
  add(pr.user);
  let unlinked = 0;
  githubAll_(repoPath_(`/pulls/${pr.number}/commits`)).forEach((commit) => {
    if (commit.author) {
      add(commit.author);
    } else {
      unlinked += 1;
    }
  });
  return { known: Array.from(byId.values()), unlinked };
}

function setCommitStatus_(sha, state, description) {
  const combined = github_("get", repoPath_(`/commits/${sha}/status`));
  const current =
    combined &&
    combined.statuses.find((s) => s.context === CONFIG.statusContext);
  if (current && current.state === state && current.description === description)
    return;
  github_("post", repoPath_(`/statuses/${sha}`), {
    state,
    context: CONFIG.statusContext,
    description,
    target_url: CONFIG.contributingUrl,
  });
}

/** Posts the request once per contributor per PR, tracked in a hidden marker. */
function requestAcceptance_(pr, missing) {
  const comments = githubAll_(repoPath_(`/issues/${pr.number}/comments`));
  const alreadyAsked = new Set();
  comments.forEach((c) => {
    const m = c.body.match(new RegExp(`<!-- ${REQUEST_MARKER}: ([^>]*) -->`));
    if (m) m[1].split(",").forEach((id) => alreadyAsked.add(Number(id)));
  });
  const toAsk = missing.filter((c) => !alreadyAsked.has(c.id));
  if (!toAsk.length) return;
  github_("post", repoPath_(`/issues/${pr.number}/comments`), {
    body: requestCommentBody_(pr.html_url, toAsk),
  });
}

function requestCommentBody_(prUrl, contributors) {
  const link = (login) => {
    const body =
      `I accept the ctrlyoke Contributor License Agreement v${CONFIG.claVersion} for ` +
      `${prUrl}. My GitHub username is ${login}.`;
    return (
      `mailto:${CONFIG.mailbox}?subject=${encodeURIComponent(CONFIG.emailSubject)}` +
      `&body=${encodeURIComponent(body)}`
    );
  };
  const mentions = contributors.map((c) => "@" + c.login).join(", ");
  const claLink = `[ctrlyoke Contributor License Agreement v${CONFIG.claVersion}](${CONFIG.claUrl})`;
  const ask =
    contributors.length === 1
      ? `please [email your acceptance](${link(contributors[0].login)}) of the ${claLink} ` +
        `to \`${CONFIG.mailbox}\`, then reply here to say you have sent it.`
      : `each of you, please email your acceptance of the ${claLink} to ` +
        `\`${CONFIG.mailbox}\`, then reply here to say you have sent it:\n\n` +
        contributors
          .map(
            (c) => `- @${c.login}: [email your acceptance](${link(c.login)})`
          )
          .join("\n") +
        "\n";
  return [
    `<!-- ${REQUEST_MARKER}: ${contributors.map((c) => c.id).join(",")} -->`,
    `${mentions} Thanks for the contribution. Before we can merge this pull request, ${ask}`,
    "",
    "Please don't post your email address or organization name here. ctrlyoke is " +
      "source-available, not open source. Our " +
      `[contributor privacy notice](${CONFIG.privacyUrl}) explains how we handle your ` +
      `acceptance. Accepting for a company? See [CONTRIBUTING.md](${CONFIG.contributingUrl}).`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------------------

function acceptanceSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return (
    book.getSheetByName(CONFIG.sheetName) || book.insertSheet(CONFIG.sheetName)
  );
}

function dataRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, COLUMNS.length).getValues();
}

function appendRow_(row) {
  acceptanceSheet_().appendRow(row);
}

/** Includes rows a person changed from needs-review to accepted by hand. */
function acceptedUserIds_() {
  const ids = new Set();
  dataRows_(acceptanceSheet_()).forEach((row) => {
    if (
      row[COL["Status"]] === STATUS.accepted &&
      String(row[COL["CLA version"]]) === CONFIG.claVersion &&
      row[COL["GitHub user ID"]]
    ) {
      ids.add(Number(row[COL["GitHub user ID"]]));
    }
  });
  return ids;
}

function notifyReview_(row) {
  if (!CONFIG.notifyOnReview) return;
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: `CLA acceptance needs review: @${row[COL["GitHub login"]] || "unknown"}`,
    body:
      `${row[COL["Note"]]}\n\nPR: ${row[COL["PR URL"]] || "none"}\n` +
      `Email: ${row[COL["Email thread"]]}\n\n` +
      `Once checked, set Status to "${STATUS.accepted}" or "${STATUS.rejected}" in the ` +
      `"${CONFIG.sheetName}" sheet, and fill in the GitHub user ID if it is empty.`,
  });
}

// ---------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------

function githubToken_() {
  const token =
    PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token)
    throw new Error("Set the GITHUB_TOKEN script property (see README.md).");
  return token;
}

function repoPath_(suffix) {
  return `/repos/${CONFIG.owner}/${CONFIG.repo}${suffix}`;
}

/** Returns parsed JSON, or null for 404. Throws on any other error. */
function github_(method, path, payload) {
  const options = {
    method,
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${githubToken_()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (payload) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(`https://api.github.com${path}`, options);
  const code = response.getResponseCode();
  if (code === 404) return null;
  if (code >= 400) {
    throw new Error(
      `GitHub ${method.toUpperCase()} ${path}: ${code} ${response.getContentText()}`
    );
  }
  const text = response.getContentText();
  return text ? JSON.parse(text) : {};
}

/** Follows pagination, up to 10 pages of 100. */
function githubAll_(path) {
  const results = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 10; page += 1) {
    const batch =
      github_("get", `${path}${sep}per_page=100&page=${page}`) || [];
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function isExempt_(login) {
  return CONFIG.exemptLogins.includes(String(login).toLowerCase());
}

function senderAddress_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

function prNumberFromUrl_(url) {
  const m = String(url).match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}
