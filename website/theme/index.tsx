import {
  DocContent,
  HomeLayout as BaseHomeLayout,
} from '@rspress/core/theme-original'
import './styles.css'

/**
 * The home page of Rspress shows the hero and the features of the
 * frontmatter only: this one also renders the Markdown content of
 * docs/index.md after the features (the typed route, compiled by Twoslash).
 */
export const HomeLayout = () => (
  <BaseHomeLayout
    afterFeatures={
      <div className="dp-home-content rp-doc">
        {/* The components of the doc pages (code blocks), without title. */}
        <DocContent components={undefined} isOverviewPage />
      </div>
    }
  />
)

export * from '@rspress/core/theme-original'
