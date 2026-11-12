import { writeFileSync } from "node:fs"
import { z } from "zod"
import { Policy } from "../src/contracts.ts"

const schema = { ...z.toJSONSchema(Policy), $id: "https://raw.githubusercontent.com/hellogafaro/tug/main/schema.json", title: "tug.json" }
writeFileSync(new URL("../schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`)
