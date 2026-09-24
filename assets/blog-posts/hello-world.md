![Hacker, incoming...](./assets/img/mr-robot.jpeg)

Hello, world...
First time using those words and not having it be the first lesson in a coding lecture.

_Super fwiggin cwazy..._

Today, I published the blog portion of the website. Yipee!

In the spirit of keeping things inline with divine beauty and natural order, I insisted on keeping my stack limited to HTML, CSS, and Javascript. How was I going to manage a multiple-post blog that's not just serverless, but static?

In times like this, I used to turn to StackOverflow for the...

...hold up, StackOverflow! The trainer -_*cough*_ -precursor to ShitGPT's Codex. The website used something called [Pagedown](https://github.com/StackExchange/pagedown) to render markdown to HTML. For my purposes, this saves me:

- _Time_: I can edit my markdown in a native markdown writer such as [stackedit.io](stackedit.io) (I cannot recommend this app enough) and write my posts as I would if I were using a traditional word processor. Not to mention all of the setup and maintenance required to configure a database for blog posts... If this were my Xbox Live profile, my gamer type would be "Just for Fun".

- _Money_: Hosting a database is not only complicated, but can get expensive. Caching copies of the database can save me funds, but the potential for abuse is still there. I had experienced this with my prior consulting company and the proprietary software. Considering three of the four accounts' databases I managed weren't properly configured, I wanted to scale back to something more holistic. Don't have time for all that, plus, nobody is paying me for this... yet.

- _From having zero swag_: Where is the fun anymore in personal websites? Like, excuse me _oooooh damn bro look at those sick react animations and transitions it's so sleek and modern_ is not something I would ever catch myself saving. Take your Bay-Area-techie, AI-deepthroating, Amodei-munching attitude as **far** away from me as possible. This website is designed with one thing in mind: looking cool as simply as possible. As far as I'm concerned, we did not need to upgrade past jQuery, greedy people just started asking too much of their web browsers.

---

No more funny business. Time to _kiss_.

Grow up. It's time to **Keep it Simple, Stupid!**

The blog pipeline is as follows:

You land on blog.html and `renderPostList()` fetches `index.json`, sorts by date, and renders each post's information. Click on any of the posts, and `renderPost()` fetches `index.json` + `assets/blog-post/{slug}.md`, and renders the individual article.

# The Pagedown conversion pipeline (renderPost):

1. `extractFencedCodeBlocks(markdown)`: pulls every ` ```lang ... ``` ` block out of the raw
   text before Pagedown ever sees it, replacing each with a unique `CODEBLOCK_PLACEHOLDER_n`
   token on its own line. The real content is pre-rendered into escaped
   `<pre><code class="language-x">` HTML and stashed in an array.
2. `extractTables(text, converter)` — same idea for GFM pipe tables: detects a header row
   followed by a `|---|---|` separator row, consumes the following body rows, and replaces the
   whole block with a `TABLE_PLACEHOLDER_n` token. Cell text is run back through
   `converter.makeHtml()` (stripped of its wrapping `<p>`) so inline formatting like `**bold**`
   still works inside cells.
3. `converter.makeHtml(text)` — Pagedown now only has to handle content it actually understands
   (headings, lists, links, bold/italic, etc.); the placeholder tokens survive untouched as plain
   paragraphs.
4. Both placeholder maps are string-replaced back into the resulting HTML
   (`<p>CODEBLOCK_PLACEHOLDER_0</p>` → the real `<pre><code>`, etc.).
5. `hljs.highlightElement()` runs over every `pre code` in the final DOM for syntax coloring.

Now, the more pressing question.

# Why?

Pagedown is a straight port of the original `Markdown.md/WMD` converter and _predates_ GitHub Flavored Markdown and has no native support for fenced code blocks or pipe tables. If I were to leave them alone, the constructs would fall through as plain paragraph text.

Two major snags came up during this fix.

- Intially, raw `<pre>` HTML was directly injected into the Markdown source, relying on Pagedown's own HTML-block-hashing to pass it through untouched. This was not sturdy enough, the regex used requires exact blank-line positioning, which I know I sure-as-hell am not going to do.
- Windows CRLF line endings in real post files expect a literal line break character (`\n`), causing detection to fail silently.

---

As with everything, myself included, it's a work in progress. There will likely be more to come with this. I need to figure out how to maintain this **KISS** approach when tackling the code and art sections of the website.

Until next time xoxo
