with open("src/index.js") as f:
    content = f.read()

old1 = '  skip: (req) => req.method === "OPTIONS",\n  keyGenerator: (req) => req.ip || "unknown",\n}));'
new1 = (
    '  skip: (req) => req.method === "OPTIONS",\n'
    '  keyGenerator: (req) => req.headers["cf-connecting-ip"] || req.ip || "unknown",\n'
    '}));'
)
assert content.count(old1) == 1, f"global limiter anchor not found, count={content.count(old1)}"
content = content.replace(old1, new1)

old2 = (
    '  message: { error: "Too many login attempts — try again in 15 minutes." },\n'
    '  skip: (req) => req.method === "OPTIONS",\n'
    '}));'
)
new2 = (
    '  message: { error: "Too many login attempts — try again in 15 minutes." },\n'
    '  skip: (req) => req.method === "OPTIONS",\n'
    '  keyGenerator: (req) => req.headers["cf-connecting-ip"] || req.ip || "unknown",\n'
    '}));'
)
assert content.count(old2) == 1, f"auth limiter anchor not found, count={content.count(old2)}"
content = content.replace(old2, new2)

old3 = (
    '  message: { error: "Too many payment requests — please slow down." },\n'
    '  skip: (req) => req.method === "OPTIONS",\n'
    '}));'
)
new3 = (
    '  message: { error: "Too many payment requests — please slow down." },\n'
    '  skip: (req) => req.method === "OPTIONS",\n'
    '  keyGenerator: (req) => req.headers["cf-connecting-ip"] || req.ip || "unknown",\n'
    '}));'
)
assert content.count(old3) == 1, f"payments limiter anchor not found, count={content.count(old3)}"
content = content.replace(old3, new3)

with open("src/index.js", "w") as f:
    f.write(content)
print("done")
