"""
Browser test for the BrewBot prototype (Playwright + Chromium).

Runs the six required conversation test cases in a real browser, using a
fake microphone (a stand-in for SpeechRecognition that "hears" scripted
phrases) so the voice paths can be tested automatically. Saves a screenshot
of each important state into tests/screenshots/.

Usage:
    python -m http.server 8123          (from the brewbot-site folder)
    python tests/browser_test.py
"""
import os, sys, time
from playwright.sync_api import sync_playwright

URL = os.environ.get("BREWBOT_URL", "http://localhost:8123/index.html")
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots", "test-run")
os.makedirs(OUT, exist_ok=True)

# Fake voice: window.__say(text) makes the next microphone session "hear" text.
FAKE_SPEECH = """
(() => {
  window.__voiceQueue = [];
  window.__say = (t, conf) => window.__voiceQueue.push({t, conf: conf || 0.9});
  class FakeRec {
    constructor(){ this.lang='en-US'; }
    start(){
      setTimeout(() => {
        this.onstart && this.onstart();
        const next = window.__voiceQueue.shift();
        if (window.__holdMic) { window.__pendingRec = this; window.__pendingNext = next; return; }
        this._deliver(next);
      }, 30);
    }
    _deliver(next){
      setTimeout(() => {
        if (!next) { this.onerror && this.onerror({error:'no-speech'}); this.onend && this.onend(); return; }
        this.onresult && this.onresult({resultIndex:0, results:[Object.assign([{transcript: next.t.slice(0, 6), confidence: 0}], {isFinal:false})]});
        setTimeout(() => {
          this.onresult && this.onresult({resultIndex:0, results:[Object.assign([{transcript: next.t, confidence: next.conf}], {isFinal:true})]});
          this.onend && this.onend();
        }, 40);
      }, 60);
    }
    abort(){ this.onerror && this.onerror({error:'aborted'}); this.onend && this.onend(); }
    stop(){ this.abort(); }
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
  // Fast fake speech output
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => {
      window.__lastSpoken = (window.__lastSpoken || '') + ' ' + u.text;
      window.__utterances = (window.__utterances || 0) + 1;
      setTimeout(() => u.onend && u.onend(), window.__slowTalk ? 4000 : 20);
    };
    window.speechSynthesis.cancel = () => {};
  }
})();
"""

failures = []

def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)

def last_bot(page):
    return page.locator(".msg.bot .bubble").last.inner_text()

def wait_idle(page):
    # Wait until BrewBot has finished thinking/speaking (and any automatic listening has ended).
    for _ in range(3):
        page.wait_for_function("document.getElementById('status').dataset.state === 'idle' || document.getElementById('status').dataset.state === 'done'", timeout=8000)
        time.sleep(0.35)
        st = page.evaluate("document.getElementById('status').dataset.state")
        if st in ("idle", "done"):
            return

def type_answer(page, text):
    page.fill("#textInput", text)
    page.press("#textInput", "Enter")
    wait_idle(page)

def tap(page, label):
    page.locator("#quickReplies .chip", has_text=label).first.click()
    wait_idle(page)

def speak(page, text, conf=0.9):
    page.evaluate("([t, c]) => window.__say(t, c)", [text, conf])
    page.click("#micBtn")
    page.wait_for_function("document.querySelectorAll('.msg.user').length > 0")
    time.sleep(0.25)
    wait_idle(page)

def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name + ".png"))

def new_page(browser):
    ctx = browser.new_context(viewport={"width": 1366, "height": 800})
    ctx.add_init_script(FAKE_SPEECH)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # Downloads that are blocked on the test machine (e.g. the natural-voice model) are not code errors.
    page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(m.text))
    page.goto(URL)
    return page, errors

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- Welcome screen ----------
    page, errors = new_page(browser)
    shot(page, "01-welcome")
    page.click("#startBtn")
    wait_idle(page)
    check("What would you like to drink" in last_bot(page), "greeting asks for drink")
    shot(page, "02-greeting")

    # ---------- Test case 1: normal completion (buttons + typing) ----------
    print("Normal completion")
    tap(page, "Latte")
    tap(page, "Medium")
    tap(page, "Hot")
    tap(page, "Oat milk")
    tap(page, "Vanilla syrup")
    tap(page, "1")
    tap(page, "As soon as possible")
    type_answer(page, "Maya")
    tap(page, "Card at pickup")
    check("Should I place the order" in last_bot(page), "reaches confirmation")
    check(page.locator(".receipt").count() == 1 and "Total with HST" in page.locator(".receipt").inner_text(), "receipt card at confirmation")
    shot(page, "03-confirmation")
    check("medium hot latte" in page.get_attribute("#pvSvg", "aria-label").lower(), "drink preview describes the drink")
    page.locator(".btn-place").click(); time.sleep(0.2); wait_idle(page)
    check("order number" in last_bot(page), "order placed")
    check(page.locator(".tracker").count() == 1 and "Received" in page.locator(".tracker").inner_text(), "order tracker appears")
    page.locator(".tr-skip").click(); time.sleep(0.3)
    check(page.locator(".tr-steps li.now", has_text="Being made").count() == 1, "tracker moves to Being made")
    shot(page, "16-tracker")
    page.locator(".tr-skip").click()
    page.wait_for_function("[...document.querySelectorAll('.msg.bot .bubble')].pop().innerText.includes('ready at the pickup counter')", timeout=8000)
    wait_idle(page)
    check(page.locator(".tracker.ready").count() == 1, "tracker shows Ready")
    check(page.title().startswith("Ready!"), "tab title says Ready")
    shot(page, "17-ready")
    check(page.locator("#ticket").is_visible(), "ticket shown")
    shot(page, "04-order-placed")

    # ---------- New order: several details at once, by voice ----------
    print("Voice: several details at once")
    tap(page, "Start a new order")
    speak(page, "two large iced oat lattes with vanilla")
    check("2 large iced lattes" in last_bot(page), "voice fills 5 slots at once")
    check(page.locator(".msg.user .msg-meta", has_text="Heard by voice").count() >= 1, "shows 'Heard by voice' with Retry/Edit")
    check(page.evaluate("document.querySelector('.avatar-svg').classList.contains('nod')"), "avatar nods when answers are saved")
    mb = page.locator("#micBtn").bounding_box()
    check(mb["width"] >= 150 and mb["height"] >= 56, "Talk button is a large target (Fitts' law)")
    shot(page, "05-voice-multi")

    # ---------- Test case: correction ----------
    print("Correction")
    type_answer(page, "actually make it almond milk")
    check("from oat milk to almond milk" in last_bot(page), "correction acknowledged")
    milk_row = page.locator("#orderList li", has_text="Milk").inner_text()
    check("Almond" in milk_row, "order panel updated")
    shot(page, "06-correction")

    # ---------- Test case: voice recognition problem -> Retry ----------
    print("Voice problem and retry")
    speak(page, "in tree tea minutes", 0.4)
    check("I heard" in last_bot(page), "says what it heard")
    check(page.locator(".heard-check button", has_text="Try again by voice").count() == 1, "offers retry by voice")
    shot(page, "07-misheard")
    page.evaluate("window.__say('in 30 minutes', 0.95)")
    page.locator(".heard-check button", has_text="Try again by voice").click()
    page.wait_for_function("[...document.querySelectorAll('.msg.bot .bubble')].pop().innerText.includes('Pickup at')", timeout=8000)
    wait_idle(page)
    check("Pickup at" in last_bot(page), "retry worked")
    check(page.locator(".msg.user", has_text="in tree tea").count() == 0, "misheard answer removed")

    # ---------- Edit link ----------
    print("Edit link")
    page.locator("#orderList li", has_text="Size").locator("button").click()
    wait_idle(page)
    check("change the size" in last_bot(page), "edit link asks size again")
    tap(page, "Small")
    check(page.locator("#orderList li", has_text="Size").inner_text().find("Small") != -1, "size changed to small")

    # ---------- Test case: missing info + invalid answer ----------
    print("Missing and invalid")
    page2, errors2 = new_page(browser)
    page2.click("#startBtn"); wait_idle(page2)
    type_answer(page2, "hot chocolate please")
    check("mocha" in last_bot(page2), "unsupported item explained")
    shot(page2, "08-invalid")
    type_answer(page2, "a latte")
    check("What size" in last_bot(page2), "missing info: asks size")
    type_answer(page2, "medium or large")
    check("Which one did you mean" in last_bot(page2), "ambiguous answer clarified")
    shot(page2, "09-clarify")
    tap(page2, "Large")

    # ---------- Listening state screenshot ----------
    page2.evaluate("window.__holdMic = true")
    page2.click("#micBtn")
    page2.wait_for_function("document.getElementById('status').dataset.state === 'listening'")
    page2.evaluate("""() => { const i = document.getElementById('interim'); i.textContent = 'iced please'; }""")
    shot(page2, "10-listening")
    page2.evaluate("window.__holdMic = false; window.__pendingRec._deliver({t:'iced please', conf:0.9})")
    wait_idle(page2)
    check("Which milk" in last_bot(page2), "voice answer accepted")

    # ---------- Pause ----------
    page2.click("#pauseBtn")
    check(page2.locator("#pausedBanner").is_visible(), "pause banner")
    shot(page2, "11-paused")
    page2.click("#resumeBtn"); wait_idle(page2)
    check("carry on" in last_bot(page2), "resume repeats question")

    # ---------- Speaking state screenshot ----------
    page2.evaluate("window.__slowTalk = true")
    page2.click("#repeatBtn")
    page2.wait_for_function("document.getElementById('status').dataset.state === 'speaking'")
    shot(page2, "12-speaking")
    page2.evaluate("window.__slowTalk = false")

    # ---------- Thinking state screenshot ----------
    page2.fill("#textInput", "oat")
    page2.press("#textInput", "Enter")
    page2.wait_for_function("document.getElementById('status').dataset.state === 'thinking'")
    shot(page2, "13-thinking")
    wait_idle(page2)

    # ---------- Speech is sent in few pieces (no long gaps between sentences) ----------
    page2.evaluate("window.__utterances = 0")
    page2.click("#repeatBtn"); wait_idle(page2)
    n = page2.evaluate("window.__utterances")
    check(1 <= n <= 2, "a reply is spoken in 1-2 pieces, not sentence by sentence (got %d)" % n)

    # ---------- Start over (button under the avatar) ----------
    page2.click("#restartCtrl"); wait_idle(page2)
    check("start over" in last_bot(page2).lower(), "start over asks first")
    tap(page2, "Yes, start over")
    check(page2.locator("#orderList li", has_text="Drink").inner_text().find("Latte") == -1, "order cleared")

    # ---------- Test log ----------
    page.click("#logBtn")
    page.fill("#participantInput", "P1")
    shot(page, "14-test-log")
    summary = page.locator("#logSummary").inner_text()
    check("Voice retries" in summary, "test log summary shows")

    # ---------- Cancel an order within the first minute ----------
    page3b = page2
    page3b.click("#restartCtrl"); wait_idle(page3b)
    if page3b.locator("#quickReplies .chip", has_text="Yes, start over").count():
        tap(page3b, "Yes, start over")
    for t in ["small hot americano no milk", "no extras", "1", "ASAP", "Sam", "cash"]:
        type_answer(page3b, t)
    page3b.locator(".btn-place").click(); time.sleep(0.2); wait_idle(page3b)
    page3b.locator(".tracker:not(.old) .tr-cancel").click()
    check("Click again" in page3b.locator(".tracker:not(.old) .tr-cancel").inner_text(), "cancel asks for a second click")
    page3b.locator(".tracker:not(.old) .tr-cancel").click(); time.sleep(0.2); wait_idle(page3b)
    check("cancelled" in last_bot(page3b) and page3b.locator(".tracker.cancelled").count() == 1, "order cancelled")
    shot(page3b, "18-cancelled")

    # ---------- Voice speed ----------
    page2.locator('.seg button[data-speed="slower"]').click()
    check(page2.get_attribute('.seg button[data-speed="slower"]', "aria-pressed") == "true", "speed button selected")
    page2.locator('.seg button[data-speed="normal"]').click()

    # ---------- Menu and Find us panels ----------
    page2.click("#navMenu")
    check(page2.locator("#menuModal").is_visible() and "Cold Brew" in page2.locator("#menuBody").inner_text(), "Menu panel opens with drinks")
    shot(page2, "15-menu")
    page2.keyboard.press("Escape")
    check(page2.locator("#menuModal").is_hidden(), "Escape closes the panel")
    page2.click("#navFind")
    check("library" in page2.locator("#findModal").inner_text(), "Find us panel opens")
    page2.locator("#findModal .modal-close").click()

    # ---------- No voice support ----------
    ctx = browser.new_context(viewport={"width": 1366, "height": 800})
    ctx.add_init_script("delete window.webkitSpeechRecognition; delete window.SpeechRecognition;")
    page3 = ctx.new_page(); page3.goto(URL)
    check("type everything" in page3.locator("#voiceNote").inner_text(), "no-voice browsers told to type")
    check(page3.locator("#micBtn").is_disabled(), "mic disabled without voice support")

    # No technical voice wording on screen; a plain note only when there is no voice at all.
    vs = page2.locator("#voiceStatus")
    used = page2.get_attribute("#muteBtn", "data-voice") or ""
    check(vs.is_hidden() or "aren’t available" in vs.inner_text(), "no technical voice label on screen (voice in use: " + used + ")")
    check("Natural voice" not in page2.locator("body").inner_text(), "no 'Natural voice' wording anywhere on the page")
    # Spoken replies are the short natural versions, and 'mic' is never spelled out.
    spoken = page2.evaluate("window.__lastSpoken || ''")
    check(" mic " not in spoken.lower(), "'mic' is pronounced as a word in speech")
    check(not errors and not errors2, "no JavaScript errors: " + "; ".join(errors + errors2))
    browser.close()

print("\n%d failures" % len(failures))
sys.exit(1 if failures else 0)
