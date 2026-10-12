"""End-to-end check of the built app against a mocked GitHub contents API.

    node build.mjs && python3 tests/e2e.py [screenshot_dir]

Serves dist/ locally, intercepts api.github.com, and walks the main flows,
including a simulated save conflict between Grant and Cass.
"""
import base64, functools, http.server, json, os, sys, threading
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
REPO = "gphill1396/lovetta-chores-data"

# ------------------------------------------------------------- mock GitHub
files = {}   # name -> {"data": obj, "sha": str}
DATA_REPO = os.environ.get("DATA_REPO_DIR")  # optional: path to a lovetta-chores-data clone
commits = []
sha_n = [0]
def new_sha():
    sha_n[0] += 1
    return f"sha{sha_n[0]}"

def mock(route, request):
    url = request.url
    name = url.split("/contents/data/")[1].split(".json")[0]
    if request.headers.get("authorization") != "Bearer test-token":
        return route.fulfill(status=401, json={"message": "Bad credentials"})
    if request.method == "GET":
        f = files.get(name)
        if not f:
            return route.fulfill(status=404, json={"message": "Not Found"})
        if request.headers.get("if-none-match") == f'"{f["sha"]}"':
            return route.fulfill(status=304, headers={"Access-Control-Allow-Origin": "*"})
        content = base64.b64encode(json.dumps(f["data"]).encode()).decode()
        return route.fulfill(status=200, json={"content": content, "sha": f["sha"]},
                             headers={"ETag": f'"{f["sha"]}"', "Access-Control-Allow-Origin": "*",
                                      "Access-Control-Expose-Headers": "ETag"})
    if request.method == "PUT":
        body = json.loads(request.post_data)
        f = files.get(name)
        if f and body.get("sha") != f["sha"]:
            return route.fulfill(status=409, json={"message": "conflict"})
        if not f and body.get("sha"):
            return route.fulfill(status=422, json={"message": "sha wasn't supplied"})
        data = json.loads(base64.b64decode(body["content"]).decode())
        files[name] = {"data": data, "sha": new_sha()}
        commits.append(body["message"])
        return route.fulfill(status=200, json={"content": {"sha": files[name]["sha"]}})
    return route.fulfill(status=405)

if DATA_REPO:
    for n in ["house", "settings", "log", "projects", "lists"]:
        files[n] = {"data": json.load(open(os.path.join(DATA_REPO, "data", n + ".json"))), "sha": new_sha()}

# -------------------------------------------------------------- web server
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "dist"))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_port}/"

errors = []
def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=False)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.route("https://api.github.com/**", mock)
    ctx.route("https://fonts.googleapis.com/**", lambda r, q: r.abort())
    ctx.route("https://fonts.gstatic.com/**", lambda r, q: r.abort())
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.clock.set_fixed_time("2026-10-12T09:00:00")
    page.goto(BASE)

    # Setup
    expect(page.get_by_role("heading", name="Lovetta chores")).to_be_visible()
    shot(page, "01-setup")
    page.get_by_role("button", name="Grant", exact=True).click()
    page.get_by_label("GitHub token").fill("wrong")
    page.get_by_role("button", name="Connect").click()
    expect(page.get_by_role("alert")).to_contain_text("token")
    page.get_by_label("GitHub token").fill("test-token")
    page.get_by_role("button", name="Connect").click()

    # Week board; data repo got seeded from the 404s
    expect(page.get_by_role("heading", name="Week of Oct 12")).to_be_visible()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert set(files) == {"house", "settings", "log", "projects", "lists"}, files.keys()
    shot(page, "02-week-mine")
    rooms_mine = page.locator(".room-head h3").all_inner_texts()
    print("Grant's rooms this week:", rooms_mine)
    assert "Kitchen" in rooms_mine and "Living room" not in rooms_mine and "Bedroom" in rooms_mine

    # Check off a chore
    page.get_by_role("button", name="Wipe counters & stove").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    done = files["log"]["data"]["done"]
    assert any(k.startswith("W2026-10-12|w-kitchen-wipe-counters") for k in done), done
    assert commits[-1] == 'Grant checked off "Wipe counters & stove"', commits[-1]

    # Cass saves from her phone in the meantime (sha changes underneath us)
    files["log"]["data"]["done"]["W2026-10-12|w-living-vacuum-floor"] = {"by": "cass", "at": "2026-10-12T08:00:00Z"}
    files["log"]["sha"] = new_sha()
    page.get_by_role("button", name="Sweep floor").first.click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    done = files["log"]["data"]["done"]
    assert "W2026-10-12|w-living-vacuum-floor" in done, "Cass's check was lost"
    assert "W2026-10-12|w-kitchen-sweep-floor" in done, "Grant's retry failed"
    print("Conflict retry kept both check-offs")

    # Uncheck
    page.get_by_role("button", name="Wipe counters & stove").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert "W2026-10-12|w-kitchen-wipe-counters-stove" not in files["log"]["data"]["done"]

    # Everyone view shows Cass's check in her ink
    page.get_by_role("button", name="Everyone").click()
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.locator(".task-by", has_text="Cass")).to_be_visible()
    shot(page, "03-week-everyone")

    # Month + seasons
    page.get_by_role("button", name="Month", exact=True).click()
    expect(page.get_by_role("heading", name="October")).to_be_visible()
    page.get_by_role("button", name="Seasons").click()
    expect(page.get_by_text("Replace furnace filter")).to_be_visible()
    expect(page.get_by_text("Stock firewood")).to_be_visible()
    shot(page, "04-seasons")

    # Projects
    page.get_by_role("button", name="Projects").click()
    if DATA_REPO:
        expect(page.locator(".project")).to_have_count(141)
    page.get_by_role("button", name="Cass", exact=True).click()
    n_cass = page.locator(".project").count()
    print("Cass-led open projects:", n_cass)
    page.get_by_role("button", name="All", exact=True).click()
    shot(page, "05-projects")
    page.get_by_role("button", name="Add a project").click()
    page.get_by_label("What needs doing").fill("Hang hinged shower door")
    page.get_by_label("Room or area").fill("Bathroom")
    page.get_by_label("Estimated cost").fill("$250–600")
    shot(page, "06-project-form")
    page.get_by_role("button", name="Add project").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert files["projects"]["data"]["projects"][0]["task"] == "Hang hinged shower door"
    first = page.locator(".project").filter(has_text="Hang hinged shower door")
    first.get_by_role("button", name="Done").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert files["projects"]["data"]["projects"][0]["status"] == "done"

    # Lists
    page.get_by_role("button", name="Lists").click()
    page.get_by_label("Add to Restock & refill").fill("Dish soap")
    page.get_by_role("button", name="Add", exact=True).click()
    page.get_by_role("button", name="Dish soap").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    items = files["lists"]["data"]["lists"][0]["items"]
    assert items[0]["text"] == "Dish soap" and items[0]["done"] is True
    page.get_by_role("button", name="Lowe's cart").click()
    shot(page, "07-lists")

    # Settings: rotate -> keep this split -> back
    page.get_by_role("button", name="Settings").click()
    expect(page.get_by_text("This week: Kitchen")).to_be_visible()
    shot(page, "08-settings")
    page.get_by_role("button", name="Keep this split").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert files["settings"]["data"]["mode"] == "fixed"
    owners = {r["id"]: r["fixedOwner"] for r in files["house"]["data"]["rooms"]}
    assert owners["kitchen"] == "grant" and owners["living"] == "cass" and owners["bedroom"] == "both", owners
    page.get_by_label("Owner of Studio & lounge").select_option("cass")
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert next(r for r in files["house"]["data"]["rooms"] if r["id"] == "studio")["fixedOwner"] == "cass"
    page.get_by_role("button", name="Take turns").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    assert files["settings"]["data"]["mode"] == "rotate"

    # Editor: add a seasonal chore
    page.get_by_role("button", name="Edit rooms and chores").click()
    page.locator(".sheet select").first.select_option("yard")
    page.get_by_role("button", name="Add a chore to Patio & yard").click()
    page.get_by_label("Chore", exact=True).fill("Put up holiday lights")
    page.locator(".sheet select").nth(1).select_option("seasonal")
    page.get_by_role("button", name="Dec").click()
    page.get_by_role("button", name="Add chore").click()
    page.wait_for_function("document.querySelector('.sync')?.textContent === 'Synced'")
    c = next(c for c in files["house"]["data"]["chores"] if c["title"] == "Put up holiday lights")
    assert c["months"] == [12] and c["freq"] == "seasonal", c
    page.get_by_role("button", name="Close").click()   # editor -> settings
    page.get_by_role("button", name="Close").click()   # settings -> app

    # Rotation math: next week Grant has side B, so the living room is his.
    side = page.evaluate("""() => {
      const L = window.__lovetta;
      const s = {mode:'rotate', rotation:{anchorWeek:'2026-10-12', anchorMonth:'2026-10', zoneAStarts:'grant'}};
      return [L.rotationSide(s,'weekly',new Date(2026,9,12)), L.rotationSide(s,'weekly',new Date(2026,9,19)),
              L.rotationSide(s,'weekly',new Date(2026,9,25)), L.rotationSide(s,'monthly',new Date(2026,10,3)),
              L.rotationSide(s,'weekly',new Date(2027,0,4))]
    }""")
    print("Side A owner for Oct 12, Oct 19, Oct 25 (Sun), Nov (month), Jan 4:", side)
    assert side[:4] == ["grant", "cass", "cass", "cass"], side

    # Dark mode render
    page.emulate_media(color_scheme="dark")
    page.get_by_role("button", name="Week", exact=True).click()
    shot(page, "09-week-dark")

    browser.close()

print("Commits:", len(commits))
for m in commits[-6:]:
    print("  ", m)
real = [e for e in errors if "Failed to load resource" not in e]
assert not real, real
print("ALL PASSED")
