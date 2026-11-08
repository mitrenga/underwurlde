<?php
  $appName = 'UNDERWURLDE';
  $appDescription = 'Play UNDERWURLDE online for free in your browser. Faithful remake of the 1984 Ultimate Play The Game ZX Spectrum classic, no download required.';
  $appPrefix = 'uw';
  $appNoscript =
    '<h1>UNDERWURLDE</h1>'.
    '<p>Underwurlde is the 1984 ZX Spectrum game by Ultimate Play The Game. Sabreman is trapped '.
    'in a castle and the caves beneath it, 597 screens of them. The monsters do not kill him, they '.
    'bounce him away — the only thing that kills is a long fall. Three exits lead out, each guarded '.
    'by a creature that falls to one weapon only.</p>'.
    '<p>This is a faithful remake that runs directly in your web browser. '.
    'There is nothing to install and nothing to download — just open the page and play. '.
    'Please enable JavaScript to start the game.</p>'.
    '<p><a href="about">More about Underwurlde and this remake</a></p>';
  $appOpenGraph = [
    'image' => 'images/poster.png',
  ];
  $appJsonLd = [
    'genre' => 'Action-adventure game',
    'isBasedOn' => [
      '@type' => 'VideoGame',
      'name' => 'Underwurlde',
      'publisher' => [
        ['@type' => 'Organization', 'name' => 'Ultimate Play The Game'],
      ],
      'datePublished' => '1984',
      'gamePlatform' => 'ZX Spectrum',
    ],
  ];
  require_once 'config/config.php';
  require_once 'app/svision/php/main.php';
