Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:EvidenceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:Scratch = Join-Path ([IO.Path]::GetTempPath()) ('nemo-fixture-validation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Scratch -Force | Out-Null

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Normalize-Transcript([AllowNull()][string]$Text) {
    if (-not $Text) { return '' }
    return [regex]::Replace(([regex]::Replace($Text.ToLowerInvariant(),'[^a-z0-9]+',' ')).Trim(),'\s+',' ')
}
function Invoke-External {
    param([string]$FilePath,[string[]]$Arguments,[int]$TimeoutSeconds,[string]$WorkingDirectory,[string]$Label)
    $stderrPath=Join-Path $script:Scratch "$Label.stderr.txt"
    $stdout=@(& $FilePath @Arguments 2> $stderrPath)
    $exitCode=$LASTEXITCODE
    return [pscustomobject]@{ exitCode=$exitCode; timedOut=$false; stdout=($stdout -join "`n"); stderr=$(if(Test-Path $stderrPath){Get-Content $stderrPath -Raw}else{''}) }
}
function Assert-Equal($Expected,$Actual,[string]$Label) {
    if ($Expected -ne $Actual) { throw "$Label expected '$Expected', got '$Actual'." }
    Write-Host "PASS $Label -> $Actual"
}

. (Join-Path $script:EvidenceRoot 'fixture-generation.ps1')

try {
    $ffmpegCommand=Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if(-not $ffmpegCommand){$ffmpegCommand=Get-Command ffmpeg -ErrorAction Stop}
    $ffmpeg=$ffmpegCommand.Source
    $paths=[ordered]@{jfk=Join-Path $script:Scratch 'jfk.wav';clean=Join-Path $script:Scratch 'clean.wav';ugly=Join-Path $script:Scratch 'ugly.wav';tiny=Join-Path $script:Scratch 'tiny.wav';long=Join-Path $script:Scratch 'long.wav'}
    foreach($entry in @(@('jfk',1),@('clean',60),@('ugly',120),@('tiny',1),@('long',1800))){
        & $ffmpeg -v error -y -f lavfi -i 'anullsrc=r=16000:cl=mono' -t ([string]$entry[1]) -c:a pcm_s16le $paths[$entry[0]]
        if($LASTEXITCODE -ne 0){throw "Synthetic WAV generation failed for $($entry[0])."}
    }
    $recipe=Get-Content -LiteralPath (Join-Path $script:EvidenceRoot 'fixture-recipe.json') -Raw|ConvertFrom-Json
    $uglyRecipe=Get-RecipeFixture $recipe 'ugly-dialogue'
    $turns=@();$overlaps=@();$phones=@();$cursor=0.0
    for($index=0;$index -lt @($uglyRecipe.turnSchedule).Count;$index++){
        $declared=$uglyRecipe.turnSchedule[$index]
        $start=if($index -eq 0){0.0}elseif([int]$declared.overlapPreviousMs -gt 0){$cursor-[int]$declared.overlapPreviousMs/1000.0}else{$cursor+[int]$declared.gapAfterPreviousMs/1000.0}
        $end=$start+5.0
        $turns += [ordered]@{id=$declared.id;speaker=$declared.speaker;start=$start;end=$end;effects=@($declared.effects)}
        if([int]$declared.overlapPreviousMs -gt 0){$overlaps += [ordered]@{turnId=$declared.id;start=$start;end=$cursor}}
        if(Test-Effect $declared 'phone-band'){$phones += [ordered]@{turnId=$declared.id;start=$start;end=$end}}
        $cursor=$end
    }
    $uglyBookmarks=@([ordered]@{word='alpha';seconds=1.0},[ordered]@{word='beta';seconds=2.0})
    $cleanBookmarks=@([ordered]@{word='clean';seconds=1.0})
    $longHash=Get-Sha256 $paths.long
    $variants=@($recipe.fixtures|Where-Object{$_.id -eq 'long-stability'}).variantCycle|ForEach-Object{[ordered]@{id=$_.id;path=$paths.long;sha256=$longHash}}
    $segments=@();for($index=0;$index -lt 4;$index++){$segments += [ordered]@{index=$index;variantId=$variants[$index].id;start=$index*450.0;end=($index+1)*450.0;sha256=$longHash}}
    $longBookmarks=@();foreach($seconds in @(10.0,460.0,910.0,1360.0)){$longBookmarks += [ordered]@{word='production';seconds=$seconds};$longBookmarks += [ordered]@{word='transcript';seconds=$seconds+0.2}}
    $joins=@();for($index=1;$index -lt 4;$index++){$base=($index-1)*2;$referenceIndexes=@($base,($base+1),($index*2),(($index*2)+1));$joins += [ordered]@{index=$index;seconds=$index*450.0;leftVariantId=$variants[$index-1].id;rightVariantId=$variants[$index].id;referenceIndexes=$referenceIndexes;expectedWords=@($referenceIndexes|ForEach-Object{$longBookmarks[$_].word})}}
    $sentinels=@();for($index=0;$index -lt 4;$index++){$sentinels += [ordered]@{seconds=[double]$longBookmarks[$index*2].seconds;wordIndex=$index*2}}
    $fixtures=[ordered]@{
        jfk=[ordered]@{id='jfk-smoke';path=$paths.jfk;duration=Get-WavDuration $paths.jfk;sha256=Get-Sha256 $paths.jfk}
        clean=[ordered]@{id='clean-keyterms';path=$paths.clean;duration=Get-WavDuration $paths.clean;sha256=Get-Sha256 $paths.clean;bookmarks=$cleanBookmarks}
        ugly=[ordered]@{id='ugly-dialogue';path=$paths.ugly;duration=Get-WavDuration $paths.ugly;sha256=Get-Sha256 $paths.ugly;bookmarks=$uglyBookmarks;turns=$turns;overlapIntervals=$overlaps;phoneIntervals=$phones;disturbanceComponents=@('hvac','reverb','clothingImpulses','tonalAmbience','phoneBand','clippedPeaks');generationFilters=@('anoisesrc=','sine=','aevalsrc=','aecho=','highpass=f=300,lowpass=f=3400','asoftclip=')}
        tiny=[ordered]@{id='failure-tiny';path=$paths.tiny;duration=Get-WavDuration $paths.tiny;sha256=Get-Sha256 $paths.tiny}
        long=[ordered]@{id='long-stability';path=$paths.long;skipped=$false;duration=Get-WavDuration $paths.long;sha256=Get-Sha256 $paths.long;variants=@($variants);segments=$segments;joins=$joins;expectedJoinCount=$joins.Count;bookmarks=$longBookmarks;sentinelPositions=$sentinels;expectedSentinelTimes=@($sentinels|ForEach-Object{$_.seconds});expectedSentinelCount=$sentinels.Count}
    }
    $validation=Test-RepresentativeFixtures $fixtures $recipe $false
    Assert-Equal $true $validation.passed 'generated duration/hash and fixture-shape validation'
    Assert-Equal 3 $fixtures.long.expectedJoinCount 'exact long join count'
    Assert-Equal 4 $fixtures.long.expectedSentinelCount 'exact long sentinel count'
    Assert-Equal $true (Test-SortedBookmarkTimes $fixtures.ugly.bookmarks) 'sorted ugly word timings'
    Assert-Equal 5 @($fixtures.ugly.overlapIntervals).Count 'bounded overlap interval count'
    Assert-Equal 1 @($fixtures.ugly.phoneIntervals).Count 'bounded phone interval count'
    Assert-Equal 'A' $fixtures.ugly.turns[0].speaker 'alternating speaker start'
    Assert-Equal 'B' $fixtures.ugly.turns[1].speaker 'alternating speaker continuation'

    $fixtures.ugly.bookmarks=@([ordered]@{word='late';seconds=2.0},[ordered]@{word='early';seconds=1.0})
    $rejected=$false
    try{[void](Test-RepresentativeFixtures $fixtures $recipe $false)}catch{$rejected=$true}
    Assert-Equal $true $rejected 'unsorted fixture gold is rejected'
    Write-Host 'All fixture generation validation tests passed.'
} finally {
    Remove-Item -LiteralPath $script:Scratch -Recurse -Force -ErrorAction SilentlyContinue
}
