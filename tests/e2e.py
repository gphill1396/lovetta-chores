"""Two-phone end-to-end test: Grant and Cass in separate browsers, one mocked data repo.

    node build.mjs && python3 tests/e2e.py [screenshot_dir]
    DATA_REPO_DIR=../lovetta-chores-data python3 tests/e2e.py   # start from the real data

Serves dist/ locally, intercepts api.github.com, and walks the main flows:
setup, Today + Next up, planning chores and projects onto days, work sessions,
check-off + undo, hand-off + accept, notes, kudos, skip, "done means", sizes,
inbox, the Week and Month plans, both check-ins, day budgets, a save conflict,
settings and the editor.
"""
import base64, functools, http.server, json, os, re, sys, threading
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
DATA_REPO = os.environ.get("DATA_REPO_DIR")
FILES = ["house", "settings", "log", "projects", "lists", "plans", "activity"]

files, commits, sha_n = {}, [], [0]
def new_sha():
    sha_n[0] += 1
    return f"sha{sha_n[0]}"
if DATA_REPO:
    for n in FILES:
        p = os.path.join(DATA_REPO, "data", n + ".json")
        if os.path.exists(p):
            files[n] = {"data": json.load(open(p)), "sha": new_sha()}

def mock(route, request):
    name = request.url.split("/contents/data/")[1].split(".json")[0]
    if request.headers.get("authorization") != "Bearer test-token":
        return route.fulfill(status=401, json={"message": "Bad credentials"})
    if request.method == "GET":
        f = files.get(name)
        if not f:
            return route.fulfill(status=404, json={"message": "Not Found"})
        if request.headers.get("if-none-match") == f'"{f["sha"]}"':
            return route.fulfill(status=304)
        content = base64.b64encode(json.dumps(f["data"]).encode()).decode()
        return route.fulfill(status=200, json={"content": content, "sha": f["sha"]},
                             headers={"ETag": f'"{f["sha"]}"', "Access-Control-Expose-Headers": "ETag"})
    if request.method == "PUT":
        body = json.loads(request.post_data)
        f = files.get(name)
        if f and body.get("sha") != f["sha"]:
            return route.fulfill(status=409, json={"message": "conflict"})
        if not f and body.get("sha"):
            return route.fulfill(status=422, json={"message": "sha wasn't supplied"})
        if f and not body.get("sha"):
            return route.fulfill(status=422, json={"message": "sha wasn't supplied"})
        files[name] = {"data": json.loads(base64.b64decode(body["content"]).decode()), "sha": new_sha()}
        commits.append(body["message"])
        return route.fulfill(status=200, json={"content": {"sha": files[name]["sha"]}})
    return route.fulfill(status=405)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "dist"))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_port}/"

errors = []
def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"))

def synced(page):
    page.wait_for_function("document.querySelector('.sync')?.getAttribute('aria-label') === 'Synced'", timeout=10000)

def refresh(page):
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.wait_for_timeout(400)

def task(scope, title):
    """The tappable title of a chore row (not its checkbox)."""
    return scope.locator(".task-title").filter(has_text=re.compile("^" + re.escape(title) + "$")).first

def tab(page, name):
    page.locator(".tabs").get_by_role("button", name=name, exact=True).click()

def close_sheet(page):
    page.locator(".sheet-head").get_by_role("button", name="Close").last.click()

def connect(browser, who, clock):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.route("https://api.github.com/**", mock)
    ctx.route("https://fonts.googleapis.com/**", lambda r, q: r.abort())
    ctx.route("https://fonts.gstatic.com/**", lambda r, q: r.abort())
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{who}: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"{who}: {m.text}"))
    page.clock.set_fixed_time(clock)
    page.goto(BASE)
    page.get_by_role("button", name=who, exact=True).click()
    page.get_by_label("Household key").fill("test-token")
    page.get_by_role("button", name="Connect").click()
    synced(page)
    return page

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")

    # ------------------------------------------------------------ Grant: setup
    g = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    g.context.route("https://api.github.com/**", mock)
    g.context.route("https://fonts.googleapis.com/**", lambda r, q: r.abort())
    g.on("pageerror", lambda e: errors.append(f"grant: {e}"))
    g.clock.set_fixed_time("2026-10-12T09:00:00")
    g.goto(BASE)
    shot(g, "01-setup")
    g.get_by_role("button", name="Grant", exact=True).click()
    g.get_by_label("Household key").fill("wrong")
    g.get_by_role("button", name="Connect").click()
    expect(g.get_by_role("alert")).to_contain_text("token")
    g.get_by_label("Household key").fill("test-token")
    g.get_by_role("button", name="Connect").click()
    synced(g)
    expect(g.get_by_role("heading", name="Monday, Oct 12")).to_be_visible()
    assert set(FILES) <= set(files), files.keys()

    # Today: Next up suggests one thing; "Do it today" plans it
    expect(g.locator(".next-up")).to_be_visible()
    next_title = g.locator(".next-up .task-title").inner_text()
    shot(g, "02-today-next-up")
    g.locator(".next-up").get_by_role("button", name="Do it today").click()
    synced(g)
    assert any(v.get("day") == "2026-10-12" for v in files["plans"]["data"]["items"].values())
    expect(task(g.locator(".room", has_text="Today"), next_title)).to_be_visible()
    print("Next up was:", next_title)

    # House: Cass's charts (bedroom split) + mowing is Grant's
    tab(g, "House")
    g.get_by_role("button", name="Weekly").click()
    g.get_by_role("button", name="Mine").click()
    bedroom = g.locator(".room", has_text="Bedroom")
    expect(task(bedroom, "Vacuum floor, under & behind bed")).to_be_visible()
    expect(task(bedroom, "Remake bed")).to_have_count(0)
    expect(task(g.locator(".room", has_text="Patio & yard"), "Mow lawn")).to_be_visible()

    # Plan from House: Wipe counters today, Sweep floor Wednesday (with the day-load chips)
    g.get_by_role("button", name="Plan Wipe counters & stove").click()
    expect(g.locator(".day-suggested")).to_have_count(1)
    shot(g, "03-plan-sheet")
    g.locator(".sheet .day-chip", has_text="Today").click()
    synced(g)
    g.get_by_role("button", name="Done", exact=True).click()
    g.get_by_role("button", name="Plan Sweep floor").first.click()
    g.locator(".sheet .day-chip", has_text="Wed").click()
    synced(g)
    g.get_by_role("button", name="Done", exact=True).click()
    plans = files["plans"]["data"]["items"]
    assert plans["W2026-10-12|w-kitchen-wipe-counters-stove"]["day"] == "2026-10-12", plans
    assert any(v.get("day") == "2026-10-14" for v in plans.values()), plans

    # Today shows it; check off, undo, redo
    tab(g, "Today")
    g.get_by_role("button", name="Check off Wipe counters & stove").click()
    synced(g)
    assert "W2026-10-12|w-kitchen-wipe-counters-stove" in files["log"]["data"]["done"]
    g.locator(".toast").get_by_role("button", name="Undo").click()
    synced(g)
    assert "W2026-10-12|w-kitchen-wipe-counters-stove" not in files["log"]["data"]["done"], "undo failed"
    g.get_by_role("button", name="Check off Wipe counters & stove").click()
    synced(g)

    # Chore card: done means, ask Cass, size, notes, edit card
    tab(g, "House")
    task(g, "Wipe fridge").click()
    g.get_by_role("button", name="Agree on what done looks like").click()
    g.get_by_label("Done means").fill("Shelves wiped, spills gone, nothing expired left inside.")
    g.get_by_role("button", name="Save", exact=True).click()
    synced(g)
    g.get_by_role("button", name="Ask Cass to take it").click()
    g.get_by_label("Note for Cass (optional)").fill("Packing for Louisville Thursday")
    g.get_by_role("button", name="Send to Cass").click()
    synced(g)
    g.locator(".chore-sheet").get_by_role("button", name="L", exact=True).click()
    synced(g)
    fridge = next(c for c in files["house"]["data"]["chores"] if c["id"] == "w-kitchen-wipe-fridge")
    assert fridge["size"] == "L" and fridge["standard"].startswith("Shelves")
    g.locator(".notes input").fill("We're out of the fridge spray")
    g.get_by_role("button", name="Post").click()
    synced(g)
    g.locator(".note").get_by_role("button", name="Edit").click()
    g.get_by_label("Edit note").fill("We're out of the fridge spray, it's on the Restock list")
    g.locator(".note").get_by_role("button", name="Save").click()
    synced(g)
    g.locator(".sheet-head").get_by_role("button", name="Edit").click()
    g.get_by_label("Chore", exact=True).fill("Wipe out fridge")
    g.get_by_role("button", name="Save chore").click()
    synced(g)
    expect(g.locator(".sheet-head h2")).to_have_text("Wipe out fridge")
    shot(g, "04-chore-card")
    close_sheet(g)

    # Project: add an XL, plan it Sat + Sun, log a work session
    g.locator(".subnav").get_by_role("button", name="Projects").click()
    g.get_by_role("button", name="Add a project").click()
    g.get_by_label("What needs doing").fill("Hang hinged shower door")
    g.get_by_label("Room or area").fill("Bathroom")
    g.get_by_label("Estimated cost").fill("$250–600")
    g.get_by_label("Size").select_option("XL")
    g.get_by_role("button", name="Add project").click()
    synced(g)
    g.locator(".project-main", has_text="Hang hinged shower door").click()
    card = g.locator(".sheet")
    card.locator(".plan-week", has_text="This week").locator(".day-chip", has_text="Sat").click()
    synced(g)
    card.locator(".plan-week", has_text="This week").locator(".day-chip", has_text="Sun").click()
    synced(g)
    door = next(p for p in files["projects"]["data"]["projects"] if p["task"] == "Hang hinged shower door")
    assert door["days"] == ["2026-10-17", "2026-10-18"] and door["size"] == "XL", door
    card.get_by_role("button", name="Worked on it today").click()
    synced(g)
    door = next(p for p in files["projects"]["data"]["projects"] if p["task"] == "Hang hinged shower door")
    assert door["sessions"][0]["day"] == "2026-10-12" and door["status"] == "doing", door
    expect(g.locator(".toast")).to_contain_text("Logged work")
    expect(g.locator(".toast").get_by_role("button", name="It's finished")).to_be_visible()
    card.locator(".notes input").fill("Lowe's has the 30in one in stock")
    card.get_by_role("button", name="Post").click()
    synced(g)
    shot(g, "05-project-card")
    close_sheet(g)
    expect(g.locator(".project", has_text="Hang hinged shower door")).to_contain_text("Sat, Sun")

    # Week plan: the project sits on Saturday with the chores
    tab(g, "Plan")
    g.locator(".subnav").get_by_role("button", name="Week").click()
    sat = g.locator(".lane", has_text="Saturday")
    expect(task(sat, "Hang hinged shower door")).to_be_visible()
    expect(sat.locator(".lane-load")).to_contain_text("3h/3h")
    expect(task(g.locator(".lane", has_text="Wednesday"), "Sweep floor")).to_be_visible()
    shot(g, "06-week")

    # "I have 15 min" on Today
    tab(g, "Today")
    g.get_by_role("button", name="15 min").click()
    expect(g.locator(".room", has_text="Fits in 15 min or less")).to_be_visible()
    g.get_by_role("button", name="Any", exact=True).click()

    # ------------------------------------------------------------- Cass
    k = connect(browser, "Cass", "2026-10-12T09:05:00")
    expect(k.locator(".request")).to_contain_text("Grant asked you to take Wipe fridge")
    expect(k.locator(".since").first).to_contain_text("Since you last looked")
    shot(k, "07-cass-today")
    k.get_by_role("button", name="I'll take it").click()
    synced(k)
    assert files["plans"]["data"]["items"]["W2026-10-12|w-kitchen-wipe-fridge"]["owner"] == "cass"
    k.locator(".btn-inbox").click()
    expect(k.locator(".feed")).to_contain_text("Grant finished Wipe counters & stove")
    expect(k.locator(".feed")).to_contain_text("Grant worked on Hang hinged shower door")
    k.locator(".feed-item", has_text="finished Wipe counters").get_by_role("button", name="Say thanks").click()
    synced(k)
    close_sheet(k)
    tab(k, "House")
    k.get_by_role("button", name="Weekly").click()
    k.get_by_role("button", name="Mine").click()
    expect(k.get_by_text("You're covering")).to_be_visible()
    task(k.locator(".room", has_text="Living room"), "Dust all surfaces").click()
    k.get_by_role("button", name="Skip this week").click()
    k.get_by_role("button", name="We're away").click()
    synced(k)
    close_sheet(k)
    k.get_by_role("button", name="Check off Wipe out fridge").click()
    synced(k)
    assert files["log"]["data"]["done"]["W2026-10-12|w-kitchen-wipe-fridge"]["by"] == "cass"
    k.get_by_role("button", name="Settings").click()
    k.get_by_role("button", name="Teal").click()
    synced(k)
    close_sheet(k)

    # ----------------------------------------------- back to Grant's phone
    refresh(g)
    expect(g.locator(".since").first).to_contain_text("thank-you")
    g.locator(".btn-inbox").click()
    expect(g.locator(".feed")).to_contain_text("Cass took Wipe")
    close_sheet(g)

    # Save conflict: both phones write the log at once
    files["log"]["data"]["done"]["W2026-10-12|w-dining-vacuum-floor"] = {"by": "cass", "at": "2026-10-12T09:06:00Z"}
    files["log"]["sha"] = new_sha()
    tab(g, "House")
    g.locator(".subnav").get_by_role("button", name="Chores").click()
    g.get_by_role("button", name="Check off Clean air fryer").click()
    synced(g)
    done = files["log"]["data"]["done"]
    assert "W2026-10-12|w-dining-vacuum-floor" in done and "W2026-10-12|w-kitchen-clean-air-fryer" in done
    print("Conflict retry kept both check-offs")

    # Lists
    tab(g, "Lists")
    g.get_by_label("Add to Restock & refill").fill("Fridge spray")
    g.get_by_role("button", name="Add", exact=True).click()
    synced(g)
    g.get_by_role("button", name="Check Fridge spray").click()
    synced(g)

    # Settings: day budgets + keep split / take turns
    g.get_by_role("button", name="Settings").click()
    g.get_by_label("Monday time").select_option("120")
    synced(g)
    assert files["settings"]["data"]["budgets"]["grant"][1] == 120
    shot(g, "08-settings")
    g.get_by_role("button", name="Keep this split").click()
    synced(g)
    assert files["settings"]["data"]["mode"] == "fixed"
    g.get_by_role("button", name="Take turns").click()
    synced(g)
    close_sheet(g)

    # Month plan: the calendar, then the month check-in picks a project
    tab(g, "Plan")
    g.locator(".subnav").get_by_role("button", name="Month").click()
    g.locator(".cal-day", has_text="17").first.click()
    expect(task(g.locator(".room", has_text="Saturday, Oct 17"), "Hang hinged shower door")).to_be_visible()
    shot(g, "09-month")
    g.get_by_role("button", name="Plan the month").click()
    g.get_by_role("button", name="Next", exact=True).click()
    g.get_by_role("button", name="Next", exact=True).click()
    g.get_by_label("Search projects for the month").fill("Lead paint check")
    g.get_by_label("Search projects for the month").fill("")
    expect(g.locator(".pick", has_text="Hang hinged shower door")).to_have_attribute("aria-pressed", "true")
    shot(g, "10-month-checkin")
    g.get_by_role("button", name="Finish").click()
    synced(g)
    assert files["settings"]["data"]["lastMonthCheckin"]["month"] == "M2026-10"

    # ------------------------------------------------ Sunday weekly check-in
    g.clock.set_fixed_time("2026-10-18T19:00:00")
    g.reload()
    synced(g)
    tab(g, "Today")
    g.get_by_role("button", name="Start check-in").click()
    expect(g.get_by_role("heading", name="Week of Oct 12")).to_be_visible()
    for _ in range(3):
        g.get_by_role("button", name="Next", exact=True).click()
    expect(g.locator(".wlg")).to_be_visible()
    row = g.locator(".cp-row", has_text="Hang hinged shower door")
    expect(row).to_contain_text("from last week")
    row.locator(".day-chip", has_text="Sat").click()
    synced(g)
    door = next(p for p in files["projects"]["data"]["projects"] if p["task"] == "Hang hinged shower door")
    assert "2026-10-24" in door["days"], door
    shot(g, "11-plan-the-week")
    g.get_by_role("button", name="Finish check-in").click()
    synced(g)
    assert files["settings"]["data"]["lastCheckin"]["week"] == "W2026-10-19"

    # Finishing the XL project from its card
    g.clock.set_fixed_time("2026-10-24T15:00:00")
    g.reload()
    synced(g)
    tab(g, "Today")
    expect(task(g.locator(".room", has_text="Today"), "Hang hinged shower door")).to_be_visible()
    g.get_by_role("button", name="Log work on Hang hinged shower door").click()
    synced(g)
    g.locator(".toast").get_by_role("button", name="It's finished").click()
    synced(g)
    door = next(p for p in files["projects"]["data"]["projects"] if p["task"] == "Hang hinged shower door")
    assert door["status"] == "done" and door["doneBy"] == "grant" and len(door["sessions"]) == 2, door

    # Editor still works (seasonal chore)
    g.get_by_role("button", name="Settings").click()
    g.get_by_role("button", name="Edit rooms and chores").click()
    g.locator(".sheet select").first.select_option("yard")
    g.get_by_role("button", name="Add a chore to Patio & yard").click()
    g.get_by_label("Chore", exact=True).fill("Put up holiday lights")
    g.locator(".sheet select").nth(1).select_option("seasonal")
    g.get_by_role("button", name="Dec").click()
    g.get_by_role("button", name="Add chore").click()
    synced(g)
    assert any(c["title"] == "Put up holiday lights" and c["months"] == [12] for c in files["house"]["data"]["chores"])

    # Dark mode, Cass's week
    k.emulate_media(color_scheme="dark")
    refresh(k)
    tab(k, "Plan")
    k.locator(".subnav").get_by_role("button", name="Week").click()
    k.get_by_role("button", name="Both of us").click()
    shot(k, "12-cass-week-dark")
    browser.close()

print(f"{len(commits)} commits, e.g.:")
for m in commits[-8:]:
    print("  ", m)
real = [e for e in errors if "Failed to load resource" not in e]
assert not real, real
print("ALL PASSED")
