Set-StrictMode -Version 2.0

function ConvertTo-SanitizedHttpUrl([string]$Url) {
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { throw 'HTTP evidence URL is not absolute.' }
    $builder = New-Object UriBuilder($uri)
    $builder.UserName = ''
    $builder.Password = ''
    $builder.Query = ''
    $builder.Fragment = ''
    return $builder.Uri.AbsoluteUri
}

function Test-AllowedAcquisitionUri([Uri]$Uri, [string[]]$AllowedHosts) {
    if ($Uri.Scheme -ne 'https' -or $Uri.UserInfo) { return $false }
    return @($AllowedHosts | Where-Object { $Uri.Host -ieq $_ }).Count -eq 1
}

function Get-PinnedModelRepositoryId($ModelLock) {
    $repositoryUri = $null
    if (-not [Uri]::TryCreate([string]$ModelLock.repository, [UriKind]::Absolute, [ref]$repositoryUri)) { return $null }
    return $repositoryUri.AbsolutePath.Trim('/')
}

function Test-PinnedModelMetadata($Metadata, $ModelLock) {
    $issues = @()
    $expectedRepositoryId = Get-PinnedModelRepositoryId $ModelLock
    $actualRepositoryId = if (Test-ObjectProperty $Metadata 'id') { [string]$Metadata.id } else { $null }
    $actualRevision = if (Test-ObjectProperty $Metadata 'sha') { [string]$Metadata.sha } else { $null }

    if (-not $expectedRepositoryId -or $actualRepositoryId -cne $expectedRepositoryId) { $issues += 'metadata repository identity does not match the pinned repository' }
    if ($actualRevision -cne [string]$ModelLock.revision) { $issues += 'metadata revision does not match the pinned revision' }

    $matchingSiblings = @()
    if (Test-ObjectProperty $Metadata 'siblings') {
        $matchingSiblings = @($Metadata.siblings | Where-Object { (Test-ObjectProperty $_ 'rfilename') -and [string]$_.rfilename -ceq [string]$ModelLock.file })
    }
    if ($matchingSiblings.Count -ne 1) { $issues += 'metadata does not contain exactly one sibling with the pinned file identity' }
    $sibling = if ($matchingSiblings.Count -eq 1) { $matchingSiblings[0] } else { $null }
    $actualBlobId = if ($null -ne $sibling -and (Test-ObjectProperty $sibling 'blobId')) { [string]$sibling.blobId } else { $null }
    $actualFileBytes = if ($null -ne $sibling -and (Test-ObjectProperty $sibling 'size')) { $sibling.size } else { $null }
    $actualLfsBytes = if ($null -ne $sibling -and (Test-ObjectProperty $sibling 'lfs') -and (Test-ObjectProperty $sibling.lfs 'size')) { $sibling.lfs.size } else { $null }
    $actualLfsSha256 = if ($null -ne $sibling -and (Test-ObjectProperty $sibling 'lfs') -and (Test-ObjectProperty $sibling.lfs 'sha256')) { [string]$sibling.lfs.sha256 } else { $null }

    if ((Test-ObjectProperty $ModelLock 'blobId') -and $actualBlobId -cne [string]$ModelLock.blobId) { $issues += 'metadata sibling blob identity does not match the pin' }
    if ($null -eq $actualFileBytes -or [int64]$actualFileBytes -ne [int64]$ModelLock.bytes) { $issues += 'metadata sibling byte count does not match the pin' }
    if ($null -eq $actualLfsBytes -or [int64]$actualLfsBytes -ne [int64]$ModelLock.bytes) { $issues += 'metadata LFS byte count does not match the pin' }
    if (-not $actualLfsSha256 -or $actualLfsSha256 -cne [string]$ModelLock.sha256) { $issues += 'metadata LFS SHA-256 does not match the pin' }

    $cardData = if (Test-ObjectProperty $Metadata 'cardData') { $Metadata.cardData } else { $null }
    $actualLicenseId = if ($null -ne $cardData -and (Test-ObjectProperty $cardData 'license')) { [string]$cardData.license } else { $null }
    $actualLicenseName = if ($null -ne $cardData -and (Test-ObjectProperty $cardData 'license_name')) { [string]$cardData.license_name } else { $null }
    $actualLicenseUrl = if ($null -ne $cardData -and (Test-ObjectProperty $cardData 'license_link')) { [string]$cardData.license_link } else { $null }
    if ($actualLicenseId -cne [string]$ModelLock.metadataLicenseId) { $issues += 'metadata license identifier does not match the pin' }
    if ($actualLicenseName -ine [string]$ModelLock.license) { $issues += 'metadata license name does not match the pinned OpenMDW-1.1 license' }
    if (-not (Test-ExactHttpsUrl $actualLicenseUrl ([string]$ModelLock.licenseUrl))) { $issues += 'metadata license URL does not match the pin' }

    return [ordered]@{
        verified=($issues.Count -eq 0)
        issues=$issues
        repositoryId=$actualRepositoryId
        revision=$actualRevision
        file=[ordered]@{ name=$(if ($null -ne $sibling) { [string]$sibling.rfilename } else { $null }); blobId=$actualBlobId; bytes=$actualFileBytes; lfsBytes=$actualLfsBytes; lfsSha256=$actualLfsSha256 }
        license=[ordered]@{ id=$actualLicenseId; name=$actualLicenseName; url=$actualLicenseUrl }
    }
}

function Open-HttpResponse([Uri]$Uri, [int]$TimeoutSeconds, [string]$UserAgent) {
    if ($Uri.Scheme -ne 'https' -or $Uri.UserInfo) { throw [IO.InvalidDataException]::new('Only credential-free HTTPS acquisition URLs are permitted.') }
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.UserAgent = $UserAgent
    $request.AllowAutoRedirect = $false
    $request.Timeout = [math]::Max(1, $TimeoutSeconds) * 1000
    $request.ReadWriteTimeout = [math]::Max(1, $TimeoutSeconds) * 1000
    try {
        $response = $request.GetResponse()
    } catch [Net.WebException] {
        if ($null -eq $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    return [pscustomobject][ordered]@{
        statusCode=[int]$response.StatusCode
        location=[string]$response.Headers['Location']
        responseUri=$response.ResponseUri
        stream=$response.GetResponseStream()
        disposable=$response
    }
}

function Copy-BoundedHttpBody($InputStream, [string]$DestinationPath, [int64]$MaximumBytes, [DateTime]$DeadlineUtc) {
    if ($null -eq $InputStream) { throw [IO.InvalidDataException]::new('Successful HTTP response had no body stream.') }
    $parent = Split-Path -Parent $DestinationPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $output = [IO.File]::Create($DestinationPath)
    $buffer = New-Object byte[] 65536
    $total = 0L
    try {
        while ($true) {
            $remainingMilliseconds = [int][math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
            if ($remainingMilliseconds -lt 1) { throw [TimeoutException]::new('HTTP response body exceeded the attempt deadline.') }
            if ($InputStream.CanTimeout) { $InputStream.ReadTimeout = $remainingMilliseconds }
            $read = $InputStream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            if ($total + $read -gt $MaximumBytes) { throw [IO.InvalidDataException]::new('HTTP response body exceeds its byte limit.') }
            $output.Write($buffer, 0, $read)
            $total += $read
        }
    } finally {
        $output.Dispose()
    }
    return $total
}

function Invoke-BoundedHttpRequest {
    param(
        [Parameter(Mandatory=$true)][string]$Uri,
        [Parameter(Mandatory=$true)][string]$DestinationPath,
        [Parameter(Mandatory=$true)][int64]$MaximumBytes,
        [int]$MaximumAttempts = 3,
        [int]$MaximumRedirects = 5,
        [int]$TimeoutSeconds = 60,
        [string]$UserAgent = 'supa-video-produzah-evidence-spike',
        [string[]]$AllowedHosts = @(),
        [scriptblock]$ResponseProvider = $null
    )
    if ($MaximumBytes -lt 1 -or $MaximumAttempts -lt 1 -or $MaximumRedirects -lt 0 -or $TimeoutSeconds -lt 1) { throw 'Invalid bounded HTTP request limits.' }
    $initialUri = $null
    if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$initialUri) -or $initialUri.Scheme -ne 'https' -or $initialUri.UserInfo) { throw 'Acquisition URL must be absolute, credential-free HTTPS.' }
    if ($AllowedHosts.Count -eq 0) { $AllowedHosts = @($initialUri.Host) }
    if (-not (Test-AllowedAcquisitionUri $initialUri $AllowedHosts)) { throw 'Initial acquisition host is not explicitly allowed.' }

    $attemptEvidence = New-Object System.Collections.Generic.List[object]
    $successfulAttempt = $null
    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
        Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
        $attemptStarted = [DateTime]::UtcNow
        $deadline = $attemptStarted.AddSeconds($TimeoutSeconds)
        $chain = New-Object System.Collections.Generic.List[object]
        $visited = @{}
        $currentUri = $initialUri
        $fatal = $false
        $attemptState = [ordered]@{ attempt=$attempt; startedUtc=$attemptStarted.ToString('o'); endedUtc=$null; succeeded=$false; error=$null; redirectChain=$null; responseBytes=$null; finalUrlHost=$null; statusCode=$null }
        try {
            for ($redirectCount = 0; $redirectCount -le $MaximumRedirects; $redirectCount++) {
                if ($visited.ContainsKey($currentUri.AbsoluteUri)) { $attemptState.error='redirect-loop'; $fatal=$true; break }
                $visited[$currentUri.AbsoluteUri] = $true
                $remainingSeconds = [int][math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
                if ($remainingSeconds -lt 1) { $attemptState.error='attempt-timeout'; break }
                $response = $null
                try {
                    $requestUri = if ($null -ne $ResponseProvider) { New-Object Uri($currentUri.OriginalString, $true) } else { $currentUri }
                    $response = if ($null -ne $ResponseProvider) { & $ResponseProvider $requestUri $remainingSeconds } else { Open-HttpResponse $requestUri $remainingSeconds $UserAgent }
                    $responseUri = $null
                    if (-not (Test-ObjectProperty $response 'responseUri') -or -not [Uri]::TryCreate([string]$response.responseUri, [UriKind]::Absolute, [ref]$responseUri) -or -not (Test-AllowedAcquisitionUri $responseUri $AllowedHosts) -or $responseUri.AbsoluteUri -cne $currentUri.AbsoluteUri) { throw [IO.InvalidDataException]::new('HTTP response URI did not match the allowed request hop.') }
                    $statusCode = [int]$response.statusCode
                    $attemptState.statusCode = $statusCode
                    $attemptState.finalUrlHost = $responseUri.Host
                    $chain.Add([pscustomobject][ordered]@{ url=(ConvertTo-SanitizedHttpUrl $responseUri.AbsoluteUri); statusCode=$statusCode })
                    if ($statusCode -in @(301,302,303,307,308)) {
                        if (-not $response.location) { $attemptState.error='redirect-without-location'; $fatal=$true; break }
                        if ($redirectCount -ge $MaximumRedirects) { $attemptState.error='redirect-limit-exceeded'; $fatal=$true; break }
                        $nextUri = New-Object Uri($currentUri, [string]$response.location)
                        if (-not (Test-AllowedAcquisitionUri $nextUri $AllowedHosts)) { $attemptState.error='unsafe-redirect-target'; $fatal=$true; break }
                        if ($visited.ContainsKey($nextUri.AbsoluteUri)) { $attemptState.error='redirect-loop'; $fatal=$true; break }
                        $currentUri = $nextUri
                        continue
                    }
                    if ($statusCode -ne 200) {
                        $attemptState.error = "http-status-$statusCode"
                        if ($statusCode -notin @(408,429) -and ($statusCode -lt 500 -or $statusCode -gt 599)) { $fatal=$true }
                        break
                    }
                    $attemptState.responseBytes = Copy-BoundedHttpBody $response.stream $DestinationPath $MaximumBytes $deadline
                    $attemptState.succeeded = $true
                    break
                } finally {
                    if ($null -ne $response) {
                        if ((Test-ObjectProperty $response 'stream') -and $null -ne $response.stream) { $response.stream.Dispose() }
                        if ((Test-ObjectProperty $response 'disposable') -and $null -ne $response.disposable) { $response.disposable.Dispose() }
                    }
                }
            }
        } catch [IO.InvalidDataException] {
            $attemptState.error = if ($_.Exception.Message -eq 'HTTP response body exceeds its byte limit.') { 'response-body-exceeds-byte-limit' } else { 'invalid-http-response' }
            $fatal = $true
        } catch [TimeoutException] {
            $attemptState.error = 'attempt-timeout'
        } catch {
            $attemptState.error = 'transport-error:' + $_.Exception.GetType().FullName
        }
        $attemptState.endedUtc = [DateTime]::UtcNow.ToString('o')
        $attemptState.redirectChain = $chain.ToArray()
        $attemptEvidence.Add([pscustomobject]$attemptState)
        if ($attemptState.succeeded) { $successfulAttempt = $attemptState; break }
        Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
        if ($fatal) { break }
        if ($attempt -lt $MaximumAttempts -and $null -eq $ResponseProvider) { Start-Sleep -Seconds ([int][math]::Pow(2, $attempt)) }
    }

    $lastAttempt = if ($null -ne $successfulAttempt) { $successfulAttempt } elseif ($attemptEvidence.Count -gt 0) { $attemptEvidence[$attemptEvidence.Count - 1] } else { $null }
    return [ordered]@{
        succeeded=($null -ne $successfulAttempt)
        canonicalUrl=(ConvertTo-SanitizedHttpUrl $initialUri.AbsoluteUri)
        attempt=$attemptEvidence.Count
        maximumAttempts=$MaximumAttempts
        maximumRedirects=$MaximumRedirects
        timeoutSeconds=$TimeoutSeconds
        maximumBytes=$MaximumBytes
        allowedHosts=@($AllowedHosts)
        finalUrlHost=$(if ($null -ne $lastAttempt) { $lastAttempt.finalUrlHost } else { $null })
        statusCode=$(if ($null -ne $lastAttempt) { $lastAttempt.statusCode } else { $null })
        responseBytes=$(if ($null -ne $lastAttempt) { $lastAttempt.responseBytes } else { $null })
        redirectChain=$(if ($null -ne $lastAttempt) { $lastAttempt.redirectChain } else { @() })
        attempts=$attemptEvidence.ToArray()
        tool="Windows PowerShell $($PSVersionTable.PSVersion) HttpWebRequest"
    }
}
