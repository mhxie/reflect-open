import type { ReactElement } from 'react'
import type { KnowledgeClassification } from '@reflect/core'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { cn } from '@/lib/utils.ts'

type KnowledgeLevel = KnowledgeClassification['level']

interface KnowledgeLevelFilterProps {
  readonly levels: readonly KnowledgeLevel[]
  readonly level: KnowledgeLevel | null
  readonly onSelect: (level: KnowledgeLevel | null) => void
}

/** One compact menu for the graph's declared knowledge levels. */
export function KnowledgeLevelFilter({
  levels,
  level,
  onSelect,
}: KnowledgeLevelFilterProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={level === null ? 'Wiki' : `Wiki: L${level}`}
        aria-pressed={level !== null}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
          level === null
            ? 'text-text-secondary hover:bg-surface-hover hover:text-text'
            : 'bg-surface-hover text-text',
        )}
      >
        {level === null ? 'Wiki' : `L${level}`}
        <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Filter by wiki level">
        <DropdownMenuRadioGroup
          value={level ?? 'all'}
          onValueChange={(value) => {
            if (value === 'all') onSelect(null)
            else {
              const selected = levels.find((candidate) => candidate === value)
              if (selected !== undefined) onSelect(selected)
            }
          }}
        >
          <DropdownMenuRadioItem value="all" closeOnClick>
            All levels
          </DropdownMenuRadioItem>
          {levels.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} closeOnClick>
              L{option}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
