
LiveCut
=======

**Live Cutting of Video Replay Snippets**

About
-----

**LiveCut** is a [Node.js](https://nodejs.org) application for the live cutting
of video replay snippets during a live event.

**LiveCut** watches a directory where a video mixing application like
[OBS Studio](https://obsproject.com) or [vMix](https://www.vmix.com)
save their replay buffers as video snippets, transfers those
video snippets to an own processing area of N replay slots, allows one
to cut each replay video snippet with the help of the video cutting
application [Lossless Cut](https://github.com/mifi/lossless-cut), and
finally renders an event summarization/highlight video by concatenating
all replay video snippets with smooth transitions with the help of
[FFmpeg-Concat](https://www.npmjs.com/package/ffmpeg-concat)
and the GLSL-based [GL Transitions](https://gl-transitions.com/).

**LiveCut** is intended to be running side-by-side to the video
mixing application and to be controlled remotely via
[Bitfocus Companion](https://bitfocus.io/companion) and its
WebSocket plugin.

Installation
------------

- Install [OBS Studio](https://obsproject.com), enable
  its replay mechanism under <i>Settings</i> &rarr;
  <i>Output</i> &rarr; <i>Replay Buffer</i>,
  configure the output directory under <i>Settings</i> &rarr;
  <i>Output</i> &rarr; <i>Recording</i>,
  configure its output filename under <i>Settings</i> &rarr;
  <i>Advanced</i> &rarr; <i>Recording</i>,
  and enable its WebSocket interface under
  <i>Tools</i> &rarr; <i>WebSocket Server Settings</i>.

- Install [Node.js](https://nodejs.org) runtime environment.

- Install [Node.js](https://nodejs.org) extra dependencies:

    ```
    $ winget install python3
    $ python3 -m pip install packaging
    $ python3 -m pip install setuptools
    ```

- Install [FFmpeg](https://www.ffmpeg.org) via:

    ```
    $ winget install ffmpeg
    ```

- Install [**LiveCut**](https://github.com/rse/livecut):

    ```
    $ git clone https://github.com/rse/livecut
    $ cd livecut
    $ npm install
    ```

- Install [Lossless Cut](https://github.com/mifi/lossless-cut).

- Install [Bitfocus Companion](https://bitfocus.io/companion)
  and configure a page with the help of the provided
  [exported configuration](src/livecut,companionconfig).

Usage
-----

Run **LiveCut** with the following command:

```
$ npm start
```

Copyright & License
-------------------

Copyright &copy; 2024 [Dr. Ralf S. Engelschall](mailto:rse@engelschall.com)<br/>
Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)

