import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

function getRulesPath(): string | null {
  const fromWebApp = join(process.cwd(), '..', 'data', 'album-consolidation-rules.json')
  const fromRepoRoot = join(process.cwd(), 'data', 'album-consolidation-rules.json')
  if (existsSync(fromWebApp)) return fromWebApp
  if (existsSync(fromRepoRoot)) return fromRepoRoot
  return null
}

export async function GET() {
  try {
    const rulesPath = getRulesPath()
    if (!rulesPath) {
      return NextResponse.json({ rules: [] })
    }

    const content = await readFile(rulesPath, 'utf-8')
    const data = JSON.parse(content)

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error reading album variations:', error)
    return NextResponse.json({ error: 'Failed to load album variations' }, { status: 500 })
  }
}
