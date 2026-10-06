#!/usr/bin/env python3
"""
Deterministic seed data for the nlsql-testbed schema.

    python3 seed.py | psql -d nlsql_test          # default scale, ~25k orders
    python3 seed.py --scale 0.2 > seed.sql         # smaller

Writes COPY blocks to stdout (no driver needed). Same seed + scale => same data.

All data is anchored to AS_OF (2026-10-05 00:00 UTC). The composer under test
must be run with the same as_of so that "last month", "this year", etc. resolve
to the same bounds as the gold SQL in eval/cases.yaml.
"""
import argparse
import bisect
import json
import math
import random
import sys
from datetime import date, datetime, timedelta, timezone

UTC = timezone.utc
AS_OF = datetime(2026, 10, 5, tzinfo=UTC)
START = datetime(2023, 1, 1, tzinfo=UTC)
SIGNUP_START = datetime(2022, 6, 1, tzinfo=UTC)

ap = argparse.ArgumentParser()
ap.add_argument("--scale", type=float, default=1.0)
ap.add_argument("--seed", type=int, default=42)
args = ap.parse_args()
R = random.Random(args.seed)
N_CUSTOMERS = int(3200 * args.scale)
N_PRODUCTS = max(60, int(360 * args.scale))
N_RANDOM_SESSIONS = int(35000 * args.scale)
N_TICKETS = int(3600 * args.scale)

out = sys.stdout


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def esc(v):
    if v is None:
        return r"\N"
    if isinstance(v, bool):
        return "t" if v else "f"
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, (dict, list)):
        v = json.dumps(v)
    s = str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def copy(table, cols, rows):
    out.write(f"COPY {table} ({', '.join(cols)}) FROM stdin;\n")
    for r in rows:
        out.write("\t".join(esc(v) for v in r) + "\n")
    out.write("\\.\n\n")


def wchoice(items, weights):
    return R.choices(items, weights=weights, k=1)[0]


def poisson(lam):
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, int(round(R.gauss(lam, math.sqrt(lam)))))
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= R.random()
        if p <= L:
            return k
        k += 1


def rand_dt(a, b):
    return a + timedelta(seconds=R.random() * (b - a).total_seconds())


# Seasonality: outdoor retail peaks in early summer and in the holidays.
MONTH_W = [0.72, 0.68, 0.85, 0.95, 1.05, 1.22, 1.25, 1.12, 0.92, 0.88, 1.30, 1.62]


def seasonal_dt(a, b):
    """Random datetime in [a, b) with month seasonality, via rejection sampling."""
    if b <= a:
        return a
    mx = max(MONTH_W)
    for _ in range(200):
        t = rand_dt(a, b)
        if R.random() < MONTH_W[t.month - 1] / mx:
            return t
    return rand_dt(a, b)


def month_floor(d):
    return datetime(d.year, d.month, 1, tzinfo=UTC)


def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    return d.replace(year=d.year + y, month=m + 1)


# ---------------------------------------------------------------------------
# reference data
# ---------------------------------------------------------------------------
REGIONS = [(1, "West", "W"), (2, "East", "E"), (3, "Central", "C"), (4, "South", "S")]
REGION_STATES = {
    1: ["CA", "OR", "WA", "NV", "AZ", "CO", "UT"],
    2: ["NY", "PA", "MA", "NJ", "VA", "MD", "CT"],
    3: ["OH", "IL", "MI", "MN", "WI", "MO", "IN"],
    4: ["TX", "FL", "GA", "NC", "TN", "AL", "LA"],
}
STATE_REGION = {s: r for r, ss in REGION_STATES.items() for s in ss}
CITIES = {
    "CA": ["San Jose", "Sacramento", "Fresno"], "OR": ["Portland", "Bend"], "WA": ["Seattle", "Spokane"],
    "NV": ["Reno", "Las Vegas"], "AZ": ["Phoenix", "Flagstaff"], "CO": ["Denver", "Boulder"], "UT": ["Salt Lake City", "Ogden"],
    "NY": ["Albany", "Buffalo", "Brooklyn"], "PA": ["Pittsburgh", "Allentown"], "MA": ["Boston", "Worcester"],
    "NJ": ["Newark", "Trenton"], "VA": ["Richmond", "Roanoke"], "MD": ["Baltimore", "Annapolis"], "CT": ["Hartford", "New Haven"],
    "OH": ["Columbus", "Cleveland"], "IL": ["Chicago", "Springfield"], "MI": ["Detroit", "Grand Rapids"],
    "MN": ["Minneapolis", "Duluth"], "WI": ["Madison", "Milwaukee"], "MO": ["St. Louis", "Kansas City"], "IN": ["Indianapolis", "Bloomington"],
    "TX": ["Austin", "Dallas", "Houston"], "FL": ["Miami", "Orlando"], "GA": ["Atlanta", "Savannah"],
    "NC": ["Asheville", "Raleigh"], "TN": ["Nashville", "Knoxville"], "AL": ["Birmingham", "Mobile"], "LA": ["New Orleans", "Baton Rouge"],
}
TAX = {s: round(0.04 + (i * 37 % 56) / 1000, 4) for i, s in enumerate(sorted(STATE_REGION))}
REGION_W = {1: 35, 2: 25, 3: 22, 4: 18}

# South has no warehouse: "orders by warehouse region" must show South as empty.
WAREHOUSES = [
    (1, "Reno DC", "Reno", "NV", 1, date(2019, 3, 1)),
    (2, "Columbus DC", "Columbus", "OH", 3, date(2020, 8, 15)),
    (3, "Allentown DC", "Allentown", "PA", 2, date(2022, 4, 1)),
]
NEAREST_WH = {1: 1, 2: 3, 3: 2, 4: 2}

CATEGORIES = [
    (1, "Camping", None), (11, "Tents", 1), (12, "Sleeping Bags", 1), (13, "Camp Kitchen", 1), (14, "Lighting", 1),
    (2, "Climbing", None), (21, "Ropes", 2), (22, "Harnesses", 2), (23, "Climbing Shoes", 2),
    (3, "Apparel", None), (31, "Jackets", 3), (32, "Base Layers", 3), (33, "Hats & Gloves", 3),
    (4, "Footwear", None), (41, "Hiking Boots", 4), (42, "Trail Runners", 4), (43, "Sandals", 4),
    (5, "Water Sports", None), (51, "Kayaks", 5), (52, "Paddles", 5), (53, "Dry Bags", 5),
    (6, "Packs", None), (61, "Daypacks", 6), (62, "Backpacking Packs", 6),
]
LEAF = {  # leaf id -> (name nouns, price range $, weight range g)
    11: (["1P Tent", "2P Tent", "3P Tent", "4P Tent", "Shelter"], (129, 649), (900, 4200)),
    12: (["20F Sleeping Bag", "30F Sleeping Bag", "Quilt", "0F Sleeping Bag"], (89, 459), (600, 2100)),
    13: (["Stove", "Cook Set", "Mug", "Water Filter", "Cooler"], (19, 249), (100, 4000)),
    14: (["Headlamp", "Lantern", "String Lights"], (19, 99), (60, 500)),
    21: (["9.5mm Rope", "9.8mm Rope", "Static Rope"], (149, 329), (2800, 4500)),
    22: (["Harness", "Kids Harness"], (49, 149), (300, 600)),
    23: (["Climbing Shoe", "Approach Shoe"], (99, 199), (450, 900)),
    31: (["Rain Jacket", "Down Jacket", "Softshell", "Fleece"], (79, 449), (250, 800)),
    32: (["Merino Top", "Merino Bottom", "Synthetic Crew"], (39, 119), (120, 300)),
    33: (["Beanie", "Sun Hat", "Glove Liner", "Mitts"], (15, 79), (40, 250)),
    41: (["Hiking Boot", "Mid Boot", "Winter Boot"], (129, 299), (900, 1600)),
    42: (["Trail Runner", "Trail Runner GTX"], (109, 189), (500, 700)),
    43: (["Sandal", "Water Shoe"], (39, 119), (300, 600)),
    51: (["Sit-on-top Kayak", "Touring Kayak", "Inflatable Kayak"], (449, 1899), (12000, 26000)),
    52: (["Kayak Paddle", "SUP Paddle"], (69, 299), (700, 1100)),
    53: (["5L Dry Bag", "10L Dry Bag", "20L Dry Bag"], (15, 49), (80, 250)),
    61: (["18L Daypack", "24L Daypack", "30L Daypack"], (49, 159), (400, 1000)),
    62: (["45L Pack", "55L Pack", "65L Pack"], (179, 379), (1100, 2300)),
}
LEAF_W = {11: 8, 12: 6, 13: 9, 14: 6, 21: 3, 22: 3, 23: 4, 31: 9, 32: 7, 33: 6, 41: 7, 42: 7, 43: 4, 51: 2, 52: 2, 53: 5, 61: 6, 62: 5}
BRANDS = ["Northpine", "Summit", "Kestrel", "Basalt", "Ridgeway", "Alder & Co", "Torrent", "Lumen", "Fjell", "Coyote", "Haven", "Strata"]
MODELS = ["Alpine", "Ridge", "Trail", "Cascade", "Granite", "Aspen", "Tundra", "Canyon", "Mesa", "Sierra", "Glacier", "Juniper"]
COLORS = ["black", "slate", "forest", "orange", "sky", "sand", "red"]
MATERIALS = ["nylon", "polyester", "merino", "down", "leather", "aluminum", "rubber"]
TAGS = [(1, "waterproof"), (2, "ultralight"), (3, "recycled materials"), (4, "vegan"), (5, "bestseller"),
        (6, "new arrival"), (7, "made in usa"), (8, "packable"), (9, "insulated"), (10, "kids")]

FIRST = ["Ava", "Liam", "Maya", "Noah", "Sofia", "Elias", "Grace", "Mateo", "Hannah", "Owen", "Zoe", "Ethan", "Nora",
         "Lucas", "Ivy", "Caleb", "Leah", "Isaac", "Ruby", "Jonah", "Clara", "Theo", "Elena", "Miles", "Amara", "Wyatt",
         "Priya", "Daniel", "Mei", "Samuel", "Fatima", "Jack", "Aisha", "Henry", "Lucia", "Kai", "Naomi", "Levi", "Sara", "Felix"]
LAST = ["Nguyen", "Garcia", "Smith", "Patel", "Johnson", "Kim", "Brown", "Lopez", "Miller", "Chen", "Davis", "Wilson",
        "Martinez", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "White", "Harris", "Clark", "Lewis", "Walker",
        "Hall", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell",
        "Roberts", "Carter", "Phillips", "Evans", "Turner"]
CO_PRE = ["West Ridge", "Westbrook", "Summit Valley", "Blue River", "Granite", "Cedar", "North Fork", "Iron Peak",
          "Pine Hollow", "Eastside", "Lakeshore", "Red Canyon"]
CO_SUF = ["Supply Co", "Outfitters", "Adventures", "Guides", "Scouts", "Rentals", "Expeditions"]

# ---------------------------------------------------------------------------
# products
# ---------------------------------------------------------------------------
products = []  # dicts
names_seen = set()
leaf_ids = list(LEAF)
for pid in range(1, N_PRODUCTS + 1):
    leaf = wchoice(leaf_ids, [LEAF_W[l] for l in leaf_ids])
    nouns, (plo, phi), (wlo, whi) = LEAF[leaf]
    brand = wchoice(BRANDS, [6, 4, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1])
    name = f"{brand} {R.choice(MODELS)} {R.choice(nouns)}"
    while name in names_seen:
        name += " II" if not name.endswith("II") else "I"
    names_seen.add(name)
    price = int(round(R.uniform(plo, phi))) * 100 - 1      # $xx.99
    launched = (START - timedelta(days=900)).date() + timedelta(days=int(R.random() ** 0.8 * 1960))
    if launched > (AS_OF - timedelta(days=20)).date():
        launched = (AS_OF - timedelta(days=20 + R.randint(0, 60))).date()
    disc = None
    if R.random() < 0.10:
        lo = datetime.combine(launched, datetime.min.time(), UTC) + timedelta(days=120)
        if lo < AS_OF - timedelta(days=30):
            disc = rand_dt(lo, AS_OF - timedelta(days=30))
    created = datetime.combine(launched, datetime.min.time(), UTC) - timedelta(days=R.randint(10, 90))
    products.append(dict(
        id=pid, sku=f"NP-{10000 + pid * 7}", name=name, category_id=leaf, brand=brand,
        list_price_cents=price, unit_cost_cents=int(price * R.uniform(0.42, 0.66)),
        weight_grams=R.randint(wlo, whi), model_year=max(2019, min(2026, launched.year + R.choice([0, 0, 1]))),
        is_active=disc is None, launched_on=launched, discontinued_at=disc,
        attributes={"color": R.choice(COLORS), "material": R.choice(MATERIALS)},
        created_at=created, updated_at=max(created, disc or created) + timedelta(days=R.randint(0, 30)),
        quality=R.uniform(3.1, 4.75),
    ))

# Popularity: heavy-tailed; ~7% of products never sell.
order_pop = list(range(len(products)))
R.shuffle(order_pop)
for rank, idx in enumerate(order_pop):
    products[idx]["pop"] = 1.0 / (rank + 1) ** 0.85
for idx in R.sample(range(len(products)), k=max(3, len(products) * 7 // 100)):
    products[idx]["pop"] = 0.0

# Per-month availability tables for fast weighted picks
avail = {}
m = month_floor(START)
while m <= AS_OF:
    mid = m + timedelta(days=14)
    ps = [p for p in products if p["pop"] > 0 and p["launched_on"] <= mid.date()
          and (p["discontinued_at"] is None or p["discontinued_at"] > mid)]
    cum, acc = [], 0.0
    for p in ps:
        acc += p["pop"]
        cum.append(acc)
    avail[(m.year, m.month)] = (ps, cum)
    m = add_months(m, 1)


def pick_product(t):
    ps, cum = avail[(t.year, t.month)]
    return ps[bisect.bisect_left(cum, R.random() * cum[-1])]


product_tags = []
for p in products:
    for tid, _ in R.sample(TAGS, k=wchoice([0, 1, 2, 3], [3, 4, 3, 1])):
        product_tags.append((p["id"], tid, p["created_at"] + timedelta(days=R.randint(0, 200))))

# ---------------------------------------------------------------------------
# customers + addresses
# ---------------------------------------------------------------------------
customers, addresses = [], []
emails = set()
addr_id = 0
for cid in range(1, N_CUSTOMERS + 1):
    seg = wchoice(["consumer", "small_business", "enterprise"], [85, 12, 3])
    region = wchoice(list(REGION_W), list(REGION_W.values()))
    fn, ln = R.choice(FIRST), R.choice(LAST)
    email = f"{fn}.{ln}{cid}@example.com".lower()
    created = SIGNUP_START + (AS_OF - timedelta(days=3) - SIGNUP_START) * math.sqrt(R.random())
    deleted = rand_dt(created + timedelta(days=30), AS_OF) if R.random() < 0.03 and created < AS_OF - timedelta(days=60) else None
    updated = max(created + timedelta(days=R.randint(0, 400)), deleted or created)
    updated = min(updated, AS_OF - timedelta(hours=1)) if not deleted else max(deleted, min(updated, AS_OF))
    c = dict(
        id=cid, email=email, first_name=fn, last_name=ln,
        company_name=f"{R.choice(CO_PRE)} {R.choice(CO_SUF)}" if seg != "consumer" else None,
        segment=seg, region_id=region,
        referred_by_customer_id=R.randint(1, cid - 1) if cid > 50 and R.random() < 0.08 else None,
        marketing_opt_in=R.random() < 0.45,
        loyalty_tier=wchoice([None, "bronze", "silver", "gold", "platinum"], [40, 30, 18, 9, 3]),
        created_at=created, updated_at=updated, deleted_at=deleted, addrs=[],
    )
    customers.append(c)
    n_addr = wchoice([1, 2, 3], [60, 30, 10])
    for k in range(n_addr):
        addr_id += 1
        # most addresses are in the home region; business customers often have an out-of-region work address
        st = R.choice(REGION_STATES[region]) if (k == 0 or R.random() < 0.6) else R.choice(list(STATE_REGION))
        label = ["home", "work", "other"][k] if seg == "consumer" else ["work", "work", "other"][k]
        addresses.append((addr_id, cid, label, f"{R.randint(10, 9999)} {R.choice(MODELS)} {R.choice(['St', 'Ave', 'Rd', 'Way'])}",
                          R.choice(CITIES[st]), st, f"{R.randint(10000, 99999)}", "US", created + timedelta(days=k * R.randint(0, 300))))
        c["addrs"].append((addr_id, st))

# ---------------------------------------------------------------------------
# orders, items, payments, refunds
# ---------------------------------------------------------------------------
orders, items, payments, refunds = [], [], [], []
SEG_RATE = {"consumer": 9.0, "small_business": 22.0, "enterprise": 40.0}   # orders per 1373 active days
SPAN_DAYS = (AS_OF - START).days
order_seq, item_seq, pay_seq, ref_seq = 0, 0, 0, 0
order_events = []
for c in customers:
    if c["segment"] == "consumer" and R.random() < 0.17:
        continue                              # never ordered
    a = max(c["created_at"], START)
    b = min(c["deleted_at"] or AS_OF, AS_OF - timedelta(minutes=5))
    if b <= a:
        continue
    lam = SEG_RATE[c["segment"]] * (b - a).days / SPAN_DAYS * R.uniform(0.3, 1.7)
    for t in sorted(seasonal_dt(a, b) for _ in range(poisson(lam))):
        order_events.append((t, c))
order_events.sort(key=lambda x: x[0])

first_order_seen = set()
for placed, c in order_events:
    order_seq += 1
    oid = order_seq
    billing = c["addrs"][0]
    shipping = c["addrs"][0] if R.random() < 0.85 or len(c["addrs"]) == 1 else R.choice(c["addrs"][1:])
    age_days = (AS_OF - placed).total_seconds() / 86400
    if age_days < 1:
        status = wchoice(["pending", "paid"], [5, 5])
    elif age_days < 3:
        status = wchoice(["paid", "shipped"], [3, 7])
    elif age_days < 8:
        status = wchoice(["shipped", "delivered"], [5, 5])
    else:
        status = "delivered"
    if age_days >= 1 and R.random() < 0.04:
        status = "cancelled"
    elif age_days >= 15 and status == "delivered" and R.random() < 0.025:
        status = "refunded"

    channel = wchoice(["web", "mobile_app", "marketplace", "phone"],
                      [55, 25 if placed.year >= 2024 else 12, 12, 8 if c["segment"] == "consumer" else 25])
    # lines
    n_lines = wchoice([1, 2, 3, 4, 5], [45, 28, 15, 8, 4])
    used, lines = set(), []
    for _ in range(n_lines):
        p = pick_product(placed)
        if p["id"] in used:
            continue
        used.add(p["id"])
        qty = wchoice([1, 2, 3, 4, 6, 10], [70, 18, 6, 3, 2, 1] if c["segment"] == "consumer" else [35, 20, 15, 12, 10, 8])
        pct = wchoice([0, 10, 15, 20, 25], [85, 5, 5, 3, 2])
        line_total = int(round(qty * p["list_price_cents"] * (1 - pct / 100)))
        item_seq += 1
        lines.append([item_seq, oid, p["id"], qty, p["list_price_cents"], f"{pct:.2f}", line_total])
    subtotal = sum(l[6] for l in lines)
    # coupon
    coupon, cpct = None, 0
    if c["id"] not in first_order_seen and R.random() < 0.35:
        coupon, cpct = "WELCOME15", 15
    elif R.random() < 0.10:
        if placed.month in (11, 12):
            coupon, cpct = "HOLIDAY20", 20
        elif placed.month in (3, 4, 5):
            coupon, cpct = "SPRING10", 10
        else:
            coupon, cpct = "NP10", 10
    first_order_seen.add(c["id"])
    discount = int(round(subtotal * cpct / 100))
    ship_state = shipping[1]
    shipping_c = 0 if subtotal - discount >= 7500 else 795
    tax = int(round((subtotal - discount) * TAX[ship_state]))
    total = subtotal - discount + shipping_c + tax

    shipped = delivered = cancelled = None
    wh = None
    if status in ("shipped", "delivered", "refunded"):
        shipped = placed + timedelta(hours=R.uniform(18, 70))
        wh = NEAREST_WH[STATE_REGION[ship_state]] if R.random() < 0.85 else R.choice([1, 2, 3])
        if placed < datetime(2022, 4, 1, tzinfo=UTC) + timedelta(days=0) and wh == 3:
            wh = 2
    if status in ("delivered", "refunded"):
        delivered = shipped + timedelta(hours=R.uniform(40, 150))
        if delivered >= AS_OF:
            delivered = None
            status = "shipped"
    if status == "cancelled":
        cancelled = placed + timedelta(hours=R.uniform(0.2, 22))
    last_event = max(t for t in (placed, shipped, delivered, cancelled) if t)

    # payments
    pt = placed + timedelta(seconds=R.randint(5, 120))
    method = "invoice" if c["segment"] != "consumer" and R.random() < 0.4 else wchoice(["card", "paypal"], [75, 25])
    if status == "pending":
        pay_seq += 1
        payments.append((pay_seq, oid, method, total, "authorized", pt))
    elif status == "cancelled":
        pay_seq += 1
        payments.append((pay_seq, oid, method, total, "voided", cancelled))
    else:
        if R.random() < 0.03:
            pay_seq += 1
            payments.append((pay_seq, oid, method, total, "failed", pt))
            pt += timedelta(minutes=R.randint(2, 30))
        if method in ("card", "paypal") and R.random() < 0.06 and total > 3000:
            gc = min(total - 1000, R.choice([2500, 5000, 10000]))
            pay_seq += 1
            payments.append((pay_seq, oid, "gift_card", gc, "captured", pt))
            pay_seq += 1
            payments.append((pay_seq, oid, method, total - gc, "captured", pt + timedelta(seconds=3)))
        else:
            pay_seq += 1
            payments.append((pay_seq, oid, method, total, "captured", pt))

    # refunds
    if status == "refunded":
        ref_seq += 1
        rt = delivered + timedelta(days=R.uniform(3, 20))
        refunds.append((ref_seq, oid, None, total, wchoice(["damaged", "wrong_item", "late", "changed_mind", "other"], [3, 2, 1, 4, 1]), min(rt, AS_OF - timedelta(hours=2))))
        last_event = max(last_event, refunds[-1][5])
    elif status == "delivered" and R.random() < 0.05:
        l = R.choice(lines)
        rt = delivered + timedelta(days=R.uniform(2, 25))
        if rt < AS_OF:
            ref_seq += 1
            refunds.append((ref_seq, oid, l[0], l[6], wchoice(["damaged", "wrong_item", "late", "changed_mind", "other"], [4, 3, 1, 3, 1]), rt))
            last_event = max(last_event, rt)

    orders.append(dict(
        id=oid, order_number=f"NP-{1000000 + oid}", customer_id=c["id"], billing_address_id=billing[0],
        shipping_address_id=shipping[0], fulfilled_from_warehouse_id=wh, status=status, channel=channel,
        coupon_code=coupon, placed_at=placed, shipped_at=shipped, delivered_at=delivered, cancelled_at=cancelled,
        subtotal_cents=subtotal, discount_cents=discount, shipping_cents=shipping_c, tax_cents=tax, total_cents=total,
        currency="USD", created_at=placed, updated_at=last_event, lines=lines, cust=c,
    ))
    items.extend(lines)

# ---------------------------------------------------------------------------
# reviews
# ---------------------------------------------------------------------------
reviews, seen_pairs = [], set()
pmap = {p["id"]: p for p in products}
TITLES = {5: ["Love it", "Perfect for the trail", "Exceeded expectations"], 4: ["Very good", "Solid gear", "Would buy again"],
          3: ["It's fine", "Okay for the price", "Mixed feelings"], 2: ["Disappointed", "Runs small", "Not durable"],
          1: ["Fell apart", "Do not buy", "Returned it"]}
rev_id = 0
for o in orders:
    if o["delivered_at"] is None:
        continue
    for l in o["lines"]:
        if R.random() < 0.12 and (o["customer_id"], l[2]) not in seen_pairs:
            t = o["delivered_at"] + timedelta(days=R.uniform(3, 30))
            if t >= AS_OF:
                continue
            seen_pairs.add((o["customer_id"], l[2]))
            q = pmap[l[2]]["quality"]
            r = max(1, min(5, int(round(R.gauss(q, 0.9)))))
            rev_id += 1
            reviews.append((rev_id, l[2], o["customer_id"], r, R.choice(TITLES[r]),
                            f"{R.choice(TITLES[r])}. Used it {R.choice(['camping', 'on a day hike', 'in the rain', 'all summer', 'on a road trip'])}.",
                            True, t))
for _ in range(len(reviews) // 20):
    c = R.choice(customers)
    p = R.choice(products)
    if (c["id"], p["id"]) in seen_pairs or p["pop"] == 0:
        continue
    t = rand_dt(max(c["created_at"], datetime.combine(p["launched_on"], datetime.min.time(), UTC)), AS_OF)
    seen_pairs.add((c["id"], p["id"]))
    r = max(1, min(5, int(round(R.gauss(p["quality"] - 0.4, 1.1)))))
    rev_id += 1
    reviews.append((rev_id, p["id"], c["id"], r, R.choice(TITLES[r]), "Saw it in store.", False, t))

# ---------------------------------------------------------------------------
# inventory snapshots (monthly, first of month)
# ---------------------------------------------------------------------------
snaps = []
for p in products:
    launch = datetime.combine(p["launched_on"], datetime.min.time(), UTC)
    for wid, *_rest in WAREHOUSES:
        level = R.randint(15, 220)
        d = month_floor(START)
        while d <= AS_OF:
            if d >= launch and (p["discontinued_at"] is None or d < p["discontinued_at"] + timedelta(days=90)):
                if p["discontinued_at"] and d >= p["discontinued_at"]:
                    level = max(0, level - R.randint(10, 60))
                else:
                    level = max(0, level + R.randint(-35, 40))
                snaps.append((p["id"], wid, d.date(), level, R.randint(0, min(12, level))))
            d = add_months(d, 1)

# ---------------------------------------------------------------------------
# employees + support tickets
# ---------------------------------------------------------------------------
employees = [
    (1, "Dana Whitaker", "dana.whitaker@northpine.example", "support", "Support Manager", None, date(2019, 5, 6), None),
    (2, "Marcus Reyes", "marcus.reyes@northpine.example", "sales", "Sales Manager", None, date(2019, 9, 16), None),
    (3, "Ingrid Solberg", "ingrid.solberg@northpine.example", "operations", "Operations Manager", None, date(2020, 1, 13), None),
]
eid = 3
for team, mgr, n, title in [("support", 1, 22, "Support Agent"), ("sales", 2, 10, "Account Executive"), ("operations", 3, 7, "Fulfillment Specialist")]:
    for _ in range(n):
        eid += 1
        fn, ln = R.choice(FIRST), R.choice(LAST)
        hired = date(2019, 6, 1) + timedelta(days=R.randint(0, 2300))
        term = hired + timedelta(days=R.randint(200, 900)) if R.random() < 0.2 else None
        if term and term >= AS_OF.date():
            term = None
        employees.append((eid, f"{fn} {ln}", f"{fn}.{ln}.{eid}@northpine.example".lower(), team, title, mgr, hired, term))
support_agents = [e for e in employees if e[3] == "support"]


def agent_at(t):
    ok = [e for e in support_agents if e[6] <= t.date() and (e[7] is None or e[7] > t.date())]
    return R.choice(ok)[0] if ok else 1


orders_by_cust = {}
for o in orders:
    orders_by_cust.setdefault(o["customer_id"], []).append(o)
SUBJECTS = ["Where is my order?", "Item arrived damaged", "Wrong size", "Return request", "Billing question",
            "Warranty claim", "Change shipping address", "Product question", "Discount code not working", "Cancel my order"]
tickets = []
cust_with_orders = [c for c in customers if c["id"] in orders_by_cust]
for tid in range(1, N_TICKETS + 1):
    c = R.choice(cust_with_orders)
    os_ = orders_by_cust[c["id"]]
    o = R.choice(os_) if R.random() < 0.7 else None
    lo = o["placed_at"] + timedelta(hours=2) if o else max(c["created_at"], START)
    opened = seasonal_dt(lo, min(lo + timedelta(days=60), AS_OF - timedelta(hours=1)))
    channel = wchoice(["email", "chat", "phone", "web_form"], [35, 30, 20, 15])
    created_by = agent_at(opened) if channel == "phone" else None
    prio = wchoice(["low", "normal", "high", "urgent"], [20, 55, 20, 5])
    age_h = (AS_OF - opened).total_seconds() / 3600
    assigned = agent_at(opened) if (age_h > 6 or R.random() < 0.7) else None
    if age_h < 72:
        status = wchoice(["open", "pending", "solved"], [5, 3, 2])
    else:
        status = wchoice(["solved", "closed"], [3, 7])
    if assigned is None:
        status = "open"
    speed = {"urgent": 0.25, "high": 0.6, "normal": 1.0, "low": 1.6}[prio]
    first = opened + timedelta(hours=R.expovariate(1 / (4 * speed))) if assigned else None
    if first and first >= AS_OF:
        first = None
    resolved = None
    if status in ("solved", "closed"):
        resolved = (first or opened) + timedelta(hours=R.expovariate(1 / (30 * speed)))
        if resolved >= AS_OF:
            resolved, status = None, "pending"
    csat = max(1, min(5, int(round(R.gauss(4.2 if resolved and (resolved - opened).total_seconds() < 86400 else 3.4, 1.0))))) \
        if resolved and R.random() < 0.55 else None
    tickets.append((tid, f"TCK-{50000 + tid}", c["id"], o["id"] if o else None, created_by, assigned, prio, status, channel,
                    R.choice(SUBJECTS), opened, first, resolved, csat))

# ---------------------------------------------------------------------------
# web sessions (no FK constraints)
# ---------------------------------------------------------------------------
PAGES = ["/", "/camping", "/climbing", "/apparel", "/footwear", "/water", "/packs", "/sale", "/blog/trail-guides", "/new"]
UTM = [None, None, None, "google", "facebook", "newsletter", "instagram", "affiliate"]
sessions, sid = [], 0
for o in orders:
    if o["channel"] in ("web", "mobile_app") and R.random() < 0.8:
        sid += 1
        start = o["placed_at"] - timedelta(minutes=R.uniform(4, 70))
        dev = "mobile" if o["channel"] == "mobile_app" else wchoice(["desktop", "mobile", "tablet"], [60, 32, 8])
        sessions.append((sid, o["customer_id"], start, o["placed_at"] + timedelta(minutes=R.uniform(0.5, 4)),
                         R.choice(PAGES), R.choice(UTM), dev, R.randint(3, 25), o["id"]))
for _ in range(N_RANDOM_SESSIONS):
    sid += 1
    start = seasonal_dt(START, AS_OF - timedelta(minutes=30))
    cust = None
    if R.random() < 0.45:
        c = R.choice(customers)
        if c["created_at"] < start and (c["deleted_at"] is None or c["deleted_at"] > start):
            cust = c["id"]
    sessions.append((sid, cust, start, start + timedelta(minutes=R.uniform(0.2, 25)), R.choice(PAGES), R.choice(UTM),
                     wchoice(["desktop", "mobile", "tablet"], [45, 47, 8]), R.randint(1, 18), None))
sessions.sort(key=lambda s: s[2])
sessions = [(i + 1,) + s[1:] for i, s in enumerate(sessions)]

# ---------------------------------------------------------------------------
# emit
# ---------------------------------------------------------------------------
out.write("-- generated by seed.py; as_of = %s, scale = %s, seed = %s\n" % (AS_OF.isoformat(), args.scale, args.seed))
out.write("SET client_min_messages = warning;\nSET search_path = shop;\nBEGIN;\n\n")
copy("regions", ["id", "name", "code"], REGIONS)
copy("warehouses", ["id", "name", "city", "state_code", "region_id", "opened_on"], WAREHOUSES)
copy("categories", ["id", "name", "parent_id"], CATEGORIES)
copy("tags", ["id", "name"], TAGS)
copy("customers", ["id", "email", "first_name", "last_name", "company_name", "segment", "region_id", "referred_by_customer_id",
                   "marketing_opt_in", "loyalty_tier", "created_at", "updated_at", "deleted_at"],
     [(c["id"], c["email"], c["first_name"], c["last_name"], c["company_name"], c["segment"], c["region_id"],
       c["referred_by_customer_id"], c["marketing_opt_in"], c["loyalty_tier"], c["created_at"], c["updated_at"], c["deleted_at"])
      for c in customers])
copy("addresses", ["id", "customer_id", "label", "line1", "city", "state_code", "postal_code", "country_code", "created_at"], addresses)
PCOLS = ["id", "sku", "name", "category_id", "brand", "list_price_cents", "unit_cost_cents", "weight_grams", "model_year",
         "is_active", "launched_on", "discontinued_at", "attributes", "created_at", "updated_at"]
copy("products", PCOLS, [[p[k] for k in PCOLS] for p in products])
copy("product_tags", ["product_id", "tag_id", "created_at"], product_tags)
OCOLS = ["id", "order_number", "customer_id", "billing_address_id", "shipping_address_id", "fulfilled_from_warehouse_id",
         "status", "channel", "coupon_code", "placed_at", "shipped_at", "delivered_at", "cancelled_at", "subtotal_cents",
         "discount_cents", "shipping_cents", "tax_cents", "total_cents", "currency", "created_at", "updated_at"]
copy("orders", OCOLS, [[o[k] for k in OCOLS] for o in orders])
copy("order_items", ["id", "order_id", "product_id", "quantity", "unit_price_cents", "discount_pct", "line_total_cents"], items)
copy("payments", ["id", "order_id", "method", "amount_cents", "status", "processed_at"], payments)
copy("refunds", ["id", "order_id", "order_item_id", "amount_cents", "reason", "refunded_at"], refunds)
copy("reviews", ["id", "product_id", "customer_id", "rating", "title", "body", "is_verified_purchase", "created_at"], reviews)
copy("inventory_snapshots", ["product_id", "warehouse_id", "snapshot_date", "on_hand_units", "reserved_units"], snaps)
copy("employees", ["id", "full_name", "email", "team", "title", "manager_id", "hired_on", "terminated_on"], employees)
copy("support_tickets", ["id", "ticket_number", "customer_id", "order_id", "created_by_employee_id", "assigned_to_employee_id",
                         "priority", "status", "channel", "subject", "opened_at", "first_response_at", "resolved_at", "csat_score"], tickets)
copy("web_sessions", ["id", "customer_id", "started_at", "ended_at", "landing_page", "utm_source", "device_type",
                      "page_views", "converted_order_id"], sessions)

for t in ["customers", "addresses", "products", "orders", "order_items", "payments", "refunds", "reviews",
          "support_tickets", "web_sessions"]:
    out.write(f"SELECT setval(pg_get_serial_sequence('shop.{t}', 'id'), (SELECT max(id) FROM shop.{t}));\n")
out.write("COMMIT;\nANALYZE;\n")
print(f"-- rows: customers={len(customers)} products={len(products)} orders={len(orders)} items={len(items)} "
      f"payments={len(payments)} refunds={len(refunds)} reviews={len(reviews)} snapshots={len(snaps)} "
      f"tickets={len(tickets)} sessions={len(sessions)}", file=sys.stderr)
