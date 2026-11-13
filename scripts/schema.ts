import { writeFileSync } from "node:fs"
import { z } from "zod"
import { Policy } from "../src/contracts.ts"

const schema = { ...z.toJSONSchema(Policy, { io: "input" }), $id: "https://raw.githubusercontent.com/g4f4r0/tug/main/schema.json", title: "tug.json" }
writeFileSync(new URL("../schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`)
