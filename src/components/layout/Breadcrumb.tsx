/**
 * Breadcrumb trail (Section 8: `Library / Goal / Subject / Chapter`).
 *
 * A presentational component driven by a list of crumbs. Pages compute their own
 * trail (deep pages will build it from loaded goal/subject/chapter names). The last
 * crumb is the current page — rendered as plain text with `aria-current="page"`;
 * earlier crumbs are router links.
 */

import { Link } from "react-router-dom";
import { ChevronRightIcon } from "../ui/icons";
import { cn } from "../../lib/utils";

export interface Crumb {
  label: string;
  /** Omit `to` on the final (current) crumb. */
  to?: string;
}

export default function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 text-sm">
        {items.map((crumb, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
              {crumb.to && !isLast ? (
                <Link
                  to={crumb.to}
                  className="rounded px-1 py-0.5 text-content-secondary transition-colors hover:text-content-primary"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={cn(
                    "px-1 py-0.5",
                    isLast ? "font-medium text-content-primary" : "text-content-secondary"
                  )}
                >
                  {crumb.label}
                </span>
              )}
              {!isLast && (
                <ChevronRightIcon width={14} height={14} className="text-content-faint" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
