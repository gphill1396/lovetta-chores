"""Two-phone end-to-end test: Grant and Cass in separate browsers, one mocked data repo.

    node build.mjs && python3 tests/e2e.py [screenshot_dir]
    DATA_REPO_DIR=../lovetta-chores-data python3 tests/e2e.py   # start from the real data

Serves dist/ locally, intercepts api.github.com, and walks the main flows:
setup, check-off + undo, planning, hand-off + accept, notes, kudos, skip,
"done means", inbox, check-in, a save conflict, settings and the editor.
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

    # ------------------------------------------------------------ Grant
    g = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
    g.context.route("https://api.github.com/**", mock)
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
    shot(g, "02-today-empty")

    # Cass's charts: bedroom split + mowing is Grant's (weekly, as needed, Apr–Oct)
    g.get_by_role("button", name="Chores", exact=True).click()
    g.get_by_role("button", name="Weekly").click()
    g.get_by_role("button", name="Mine").click()
    bedroom = g.locator(".room", has_text="Bedroom")
    expect(task(bedroom, "Vacuum floor, under & behind bed")).to_be_visible()
    expect(task(bedroom, "Remake bed")).to_have_count(0)
    expect(task(g.locator(".room", has_text="Patio & yard"), "Mow lawn")).to_be_visible()
    task(g, "Mow lawn").click()
    expect(g.locator(".chore-sheet")).to_contain_text("Every week, Apr–Oct, as needed")
    expect(g.locator(".chore-sheet")).to_contain_text("Yours this week")
    g.locator(".sheet").get_by_role("button", name="Today", exact=True).click()
    synced(g)
    close_sheet(g)
    g.locator(".tabs").get_by_role("button", name="Today", exact=True).click()
    expect(task(g.locator(".room", has_text="Today"), "Mow lawn")).to_be_visible()
    g.get_by_role("button", name="Check off Mow lawn").click()
    synced(g)
    assert files["log"]["data"]["done"]["W2026-10-12|s-yard-mow-lawn"]["by"] == "grant"
    g.clock.set_fixed_time("2026-11-09T09:00:00")
    g.reload(); synced(g)
    g.get_by_role("button", name="Chores", exact=True).click()
    g.get_by_role("button", name="Everyone").click()
    expect(task(g, "Mow lawn")).to_have_count(0)
    g.clock.set_fixed_time("2026-10-12T09:00:00")
    g.reload(); synced(g)
    g.get_by_role("button", name="Mine").click()

    # Plan the week: Kitchen counters on Monday (today), Sweep floor on Wednesday
    g.get_by_role("button", name="Week", exact=True).click()
    expect(g.get_by_role("heading", name="Week of Oct 12")).to_be_visible()
    g.get_by_role("button", name=re.compile("chores? needs? a day")).click()
    task(g.locator(".room-tray"), "Wipe counters & stove").click()
    g.locator(".sheet").get_by_role("button", name="Today", exact=True).click()
    synced(g)
    close_sheet(g)
    task(g.locator(".room-tray"), "Sweep floor").click()
    g.get_by_role("button", name="Wed", exact=True).click()
    synced(g)
    close_sheet(g)
    plans = files["plans"]["data"]["items"]
    assert plans["W2026-10-12|w-kitchen-wipe-counters-stove"]["day"] == "2026-10-12", plans
    assert any(v.get("day") == "2026-10-14" for v in plans.values()), plans
    shot(g, "03-week")

    # Today shows the planned chore; check it off; undo; redo
    g.get_by_role("button", name="Today", exact=True).click()
    expect(task(g, "Wipe counters & stove")).to_be_visible()
    g.get_by_role("button", name="Check off Wipe counters & stove").click()
    synced(g)
    assert "W2026-10-12|w-kitchen-wipe-counters-stove" in files["log"]["data"]["done"]
    g.locator(".toast").get_by_role("button", name="Undo").click()
    synced(g)
    assert "W2026-10-12|w-kitchen-wipe-counters-stove" not in files["log"]["data"]["done"], "undo failed"
    g.get_by_role("button", name="Check off Wipe counters & stove").click()
    synced(g)
    expect(g.get_by_text("All done for today")).to_be_visible()
    shot(g, "04-today-done")

    # "Done means…" on Wipe fridge, and ask Cass to take it this week
    g.get_by_role("button", name="Chores", exact=True).click()
    task(g, "Wipe fridge").click()
    g.get_by_role("button", name="Agree on what done looks like").click()
    g.get_by_label("Done means").fill("Shelves wiped, spills gone, nothing expired left inside.")
    g.get_by_role("button", name="Save", exact=True).click()
    synced(g)
    c = next(c for c in files["house"]["data"]["chores"] if c["id"] == "w-kitchen-wipe-fridge")
    assert c["standard"].startswith("Shelves wiped") and c["standardBy"] == "grant"
    g.get_by_role("button", name="Ask Cass to take it").click()
    g.get_by_label("Note for Cass (optional)").fill("Packing for Louisville Thursday")
    shot(g, "05-ask")
    g.get_by_role("button", name="Send to Cass").click()
    synced(g)
    req = next(a for a in files["activity"]["data"]["items"] if a["kind"] == "request")
    assert req["status"] == "open" and req["to"] == "cass"
    g.get_by_role("button", name="Big").click()
    synced(g)
    assert next(c for c in files["house"]["data"]["chores"] if c["id"] == "w-kitchen-wipe-fridge")["effort"] == 3
    g.locator(".notes input").fill("We're out of the fridge spray")
    g.get_by_role("button", name="Post").click()
    synced(g)
    shot(g, "06-chore-sheet")
    close_sheet(g)

    # ------------------------------------------------------------- Cass
    k = connect(browser, "Cass", "2026-10-12T09:05:00")
    expect(k.locator(".request")).to_contain_text("Grant asked you to take Wipe fridge")
    expect(k.locator(".request")).to_contain_text("Packing for Louisville")
    expect(k.locator(".since").first).to_contain_text("Since you last looked")
    shot(k, "07-cass-today")
    expect(k.locator(".btn-inbox .badge")).to_be_visible()
    k.get_by_role("button", name="I'll take it").click()
    synced(k)
    assert next(a for a in files["activity"]["data"]["items"] if a["kind"] == "request")["status"] == "accepted"
    assert files["plans"]["data"]["items"]["W2026-10-12|w-kitchen-wipe-fridge"]["owner"] == "cass"

    # Cass's Week tab: the fridge is hers this week (covering)
    k.get_by_role("button", name="Week", exact=True).click()
    k.get_by_role("button", name="Mine").click()
    k.get_by_role("button", name=re.compile("chores? needs? a day")).click()
    expect(k.get_by_text("You're covering")).to_be_visible()

    # Cass thanks Grant from the inbox and leaves a reply note
    k.locator(".btn-inbox").click()
    expect(k.locator(".feed")).to_contain_text("Grant finished Wipe counters & stove")
    expect(k.locator(".feed")).to_contain_text("We're out of the fridge spray")
    shot(k, "08-cass-inbox")
    k.locator(".feed-item", has_text="finished Wipe counters").get_by_role("button", name="Say thanks").click()
    synced(k)
    assert any(a["kind"] == "kudos" and a["to"] == "grant" for a in files["activity"]["data"]["items"])
    close_sheet(k)
    expect(k.locator(".btn-inbox .badge")).to_have_count(0)

    # Cass skips Dust all surfaces in the living room
    k.get_by_role("button", name="Chores", exact=True).click()
    task(k.locator(".room", has_text="Living room"), "Dust all surfaces").click()
    k.get_by_role("button", name="Skip this week").click()
    k.get_by_role("button", name="We're away").click()
    synced(k)
    close_sheet(k)
    skipped = files["plans"]["data"]["items"]["W2026-10-12|w-living-dust-all-surfaces"]["skip"]
    assert skipped["by"] == "cass" and skipped["reason"] == "We're away"

    # Cass picks a different ink color
    k.get_by_role("button", name="Settings").click()
    k.get_by_role("button", name="Plum").click()
    synced(k)
    assert files["settings"]["data"]["colors"]["cass"] == "plum"
    k.get_by_role("button", name="Larger").click()
    close_sheet(k)

    # Cass checks off the fridge (in her ink)
    k.get_by_role("button", name="Today", exact=True).click()
    k.get_by_role("button", name="Also yours this week, no day yet").click()
    k.get_by_role("button", name="Check off Wipe fridge").click()
    synced(k)
    assert files["log"]["data"]["done"]["W2026-10-12|w-kitchen-wipe-fridge"]["by"] == "cass"
    shot(k, "09-cass-today-larger")

    # --------------------------------------------- back to Grant's phone
    refresh(g)
    g.get_by_role("button", name="Today", exact=True).click()
    expect(g.locator(".since").first).to_contain_text("thank-you")
    g.locator(".btn-inbox").click()
    expect(g.locator(".feed")).to_contain_text("Cass took Wipe fridge")
    expect(g.locator(".feed")).to_contain_text("Cass said thanks for Wipe counters")
    shot(g, "10-grant-inbox")
    close_sheet(g)

    # Save conflict: Cass and Grant write the log at the same moment
    files["log"]["data"]["done"]["W2026-10-12|w-dining-vacuum-floor"] = {"by": "cass", "at": "2026-10-12T09:06:00Z"}
    files["log"]["sha"] = new_sha()
    g.get_by_role("button", name="Chores", exact=True).click()
    g.get_by_role("button", name="Check off Put away dishes").click()
    synced(g)
    done = files["log"]["data"]["done"]
    assert "W2026-10-12|w-dining-vacuum-floor" in done and "W2026-10-12|w-kitchen-put-away-dishes" in done
    print("Conflict retry kept both check-offs")

    # Projects: add one, pick it for this week, note on it
    g.get_by_role("button", name="Projects").click()
    g.get_by_role("button", name="Add a project").click()
    g.get_by_label("What needs doing").fill("Hang hinged shower door")
    g.get_by_label("Room or area").fill("Bathroom")
    g.get_by_label("Estimated cost").fill("$250–600")
    g.get_by_role("button", name="Add project").click()
    synced(g)
    g.locator(".project-main", has_text="Hang hinged shower door").click()
    g.get_by_role("button", name="Pick for this week").click()
    synced(g)
    g.locator(".notes input").fill("Lowe's has the 30in one in stock")
    g.get_by_role("button", name="Post").click()
    synced(g)
    close_sheet(g)
    p = files["projects"]["data"]["projects"][0]
    assert p["task"] == "Hang hinged shower door" and p["focus"] == "W2026-10-12"

    # Lists with undo
    g.get_by_role("button", name="Lists").click()
    g.get_by_label("Add to Restock & refill").fill("Fridge spray")
    g.get_by_role("button", name="Add", exact=True).click()
    synced(g)
    g.get_by_role("button", name="Check Fridge spray").click()
    synced(g)
    assert files["lists"]["data"]["lists"][0]["items"][-1]["done"] is True
    shot(g, "11-lists")

    # Settings: keep this split, then back to taking turns
    g.get_by_role("button", name="Settings").click()
    shot(g, "12-settings")
    g.get_by_role("button", name="Keep this split").click()
    synced(g)
    assert files["settings"]["data"]["mode"] == "fixed"
    g.get_by_role("button", name="Take turns").click()
    synced(g)
    assert files["settings"]["data"]["mode"] == "rotate"
    close_sheet(g)

    # ------------------------------------------------ Sunday check-in
    g.clock.set_fixed_time("2026-10-18T19:00:00")
    g.reload()
    synced(g)
    g.get_by_role("button", name="Today", exact=True).click()
    g.get_by_role("button", name="Start check-in").click()
    expect(g.get_by_role("heading", name="Week of Oct 12")).to_be_visible()
    shot(g, "13-checkin")
    g.get_by_role("button", name="Next", exact=True).click()
    g.get_by_role("button", name="Next", exact=True).click()
    expect(g.get_by_text("You're taking turns")).to_be_visible()
    g.get_by_role("button", name="Next", exact=True).click()
    g.locator(".pick", has_text="Hang hinged shower door").click()
    synced(g)
    shot(g, "14-checkin-projects")
    g.get_by_role("button", name="Finish check-in").click()
    synced(g)
    assert files["settings"]["data"]["lastCheckin"]["week"] == "W2026-10-19"
    assert next(p for p in files["projects"]["data"]["projects"] if p["task"] == "Hang hinged shower door")["focus"] == "W2026-10-19"
    expect(g.get_by_role("button", name="Start check-in")).to_have_count(0)

    # Editor still works (add a seasonal chore)
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

    # Dark mode, Cass's phone
    k.emulate_media(color_scheme="dark")
    refresh(k)
    k.get_by_role("button", name="Week", exact=True).click()
    k.get_by_role("button", name="Both of us").click()
    shot(k, "15-cass-week-dark")
    browser.close()

print(f"{len(commits)} commits, e.g.:")
for m in commits[-8:]:
    print("  ", m)
real = [e for e in errors if "Failed to load resource" not in e]
assert not real, real
print("ALL PASSED")
