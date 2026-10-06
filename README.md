# My website

Including a README.md seems redundant, but I wanted to put something here anyway for repo's sake.

Just go to the website https://ryaneng.land

## Design choices

I'm one guy with a ton of different hobbies. I have no interest in developing/maintaining a full React website. There's a beauty in the simplicity of the OG web stack (HTML/CSS/JS). I want this website to feel like stepping back into 2003, with my own flare. Choke on it, idc.

For the blog. I'm using pagedown (https://github.com/StackExchange/pagedown). Same MD -> HTML converter used by the one and only StackOverflow. RIP.

Code, Blog, and Art share the `post-list` styles: right-aligned titles, dates,
and descriptions, with divider lines between entries. Each page also has a
centered section header with black text on a tan background on its listing.
Individual Blog and Art posts omit this section header. Blog and Art entries
come from their respective JSON indexes; Code entries are maintained in
`code.html`, with dates stored in each `<time datetime="YYYY-MM-DD">` element.

The Code listing links to a large, generative canvas garden on `code/garden.html`.
The garden is public and requires no access code or API connection. It grows on its
own; mouse and touch input accelerate growth and encourage branching. Focus the
canvas and use arrow keys or Space for keyboard control. The attached reset
button clears all growth and plants 3-7 fresh seeds randomly across the canvas.
Reduced-motion preferences
disable automatic growth in favor of input-driven bursts. Growth pauses off
screen and in hidden tabs, and is capped to keep long visits responsive.
Resizing preserves the garden. Its standalone styles and behavior are in
`assets/css/garden.css` and `assets/js/garden.js`; no build step or external
libraries are needed.
Automatic growth runs at six steps per second, one-fifth of the original rate;
input-driven bursts use the same one-fifth scale.
Each growth step is one-third of its original length, including pointer-boosted
growth.
Automatic growth is interpolated across animation frames: stems extend smoothly
between simulation steps and new leaves and blooms fade in. Finished growth is
cached on a separate canvas to avoid redrawing the entire garden each frame.
Input-driven bursts remain immediate, including in reduced-motion mode.

## Publishing

GitHub Pages uses the **Publish Website** Actions workflow. Before running it,
set repository Actions **variables** `IMAGE_TOOLS_API_URL` and
`RECAPTCHA_SITE_KEY`; the ignored local `.env` is not uploaded to GitHub.
See [GitHub Pages setup](services/image-converter/README.md#github-pages-setup)
for the exact settings and rerun steps.
