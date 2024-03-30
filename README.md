
LiveCut
=======

**Live Cutting of Video Replay Snippets**

About
-----

**LiveCut** is a server application for the live cutting
of video replay snippets during a live event.

**LiveCut** watches a directory where a video mixing application like
[OBS Studio](https://obsproject.com) or [vMix](https://www.vmix.com)
save their replay buffers as video snippets, transfers those
video snippets to a processing area of N slots, allows one
to cut each video snippets with the help of the video cutter
[Lossless Cut](https://github.com/mifi/lossless-cut), and
finally renders an event highlight video by concatenating
all replay video snippets with transitions with the help of
[FFmpeg-Concat](https://www.npmjs.com/package/ffmpeg-concat).

Installation
------------

```
$ winget install ffmpeg
$ winget install python3
$ python3 -m pip install packaging
$ python3 -m pip install setuptools
$ npm install
```

Copyright & License
-------------------

Copyright &copy; 2024 [Dr. Ralf S. Engelschall](mailto:rse@engelschall.com)<br/>
Licensed under [GPL 3.0](https://spdx.org/licenses/GPL-3.0-only)

